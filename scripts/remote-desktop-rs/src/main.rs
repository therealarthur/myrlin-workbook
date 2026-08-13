//! High-performance remote desktop server for macOS.
//!
//! Captures the screen via CoreGraphics CGDisplayCreateImage, encodes frames
//! as JPEG, streams them over WebSocket, and receives mouse/keyboard input events
//! from a browser-based HTML5 viewer.
//!
//! Usage:
//!   remote-desktop [--port 9877] [--fps 20] [--quality 75] [--scale 0.5]

use std::collections::HashMap;
use std::io::Cursor;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use clap::Parser;
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton, EventField,
    ScrollEventUnit,
};
// Note: ScrollEventUnit is a struct with const PIXEL and LINE fields.
// new_scroll_event takes CGScrollEventUnit (a u32 type alias).
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use futures_util::{SinkExt, StreamExt};
use image::codecs::jpeg::JpegEncoder;
use image::ImageEncoder;
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

/// macOS remote desktop server -- CoreGraphics capture + WebSocket streaming
#[derive(Parser, Debug, Clone)]
#[command(version, about)]
struct Args {
    /// Port for HTTP and WebSocket server
    #[arg(long, default_value_t = 9877, env = "RD_PORT")]
    port: u16,

    /// Target frames per second
    #[arg(long, default_value_t = 20, env = "RD_FPS")]
    fps: u32,

    /// JPEG quality (1-100)
    #[arg(long, default_value_t = 75, env = "RD_QUALITY")]
    quality: u32,

    /// Capture scale factor (0.0-1.0, e.g. 0.5 for half resolution)
    #[arg(long, default_value_t = 0.5, env = "RD_SCALE")]
    scale: f64,
}

// ---------------------------------------------------------------------------
// Shared state between capture thread and WebSocket connections
// ---------------------------------------------------------------------------

/// A captured and JPEG-encoded frame ready for transmission.
#[derive(Clone)]
struct Frame {
    /// JPEG bytes
    data: Bytes,
    /// Width of the encoded image
    width: u32,
    /// Height of the encoded image
    height: u32,
    /// Monotonic sequence number
    seq: u64,
}

/// Shared runtime configuration that clients can update dynamically.
struct SharedConfig {
    fps: AtomicU32,
    quality: AtomicU32,
    scale_x100: AtomicU32,
    running: AtomicBool,
    capture_ms: AtomicU64,
    encode_ms: AtomicU64,
    native_width: AtomicU32,
    native_height: AtomicU32,
}

// ---------------------------------------------------------------------------
// Screen capture (runs on a dedicated OS thread)
// ---------------------------------------------------------------------------

/// Captures the entire screen using CGDisplay::image(), scales it down,
/// encodes as JPEG, and publishes via a watch channel. This function runs on
/// a dedicated OS thread because CoreGraphics calls are blocking.
fn capture_loop(tx: watch::Sender<Option<Frame>>, config: Arc<SharedConfig>) {
    let mut seq: u64 = 0;
    let mut prev_hash: u64 = 0;
    let mut last_frame: Option<Frame> = None;
    let mut static_frames: u32 = 0;

    while config.running.load(Ordering::Relaxed) {
        let frame_start = Instant::now();
        let fps = config.fps.load(Ordering::Relaxed).max(1);
        let quality = config.quality.load(Ordering::Relaxed).clamp(1, 100);
        let scale = config.scale_x100.load(Ordering::Relaxed) as f64 / 100.0;

        // Capture the full screen. We use CGDisplay::image() on the main display which
        // calls CGDisplayCreateImage internally. This is the most reliable method and
        // avoids needing to construct CGRectInfinite which isn't exposed by the Rust crate.
        // For multi-monitor setups, CGDisplay::main() returns the display with the menu bar.
        let capture_start = Instant::now();
        let main_display = CGDisplay::main();
        let cg_image = main_display.image();
        let capture_elapsed = capture_start.elapsed();
        config
            .capture_ms
            .store(capture_elapsed.as_millis() as u64, Ordering::Relaxed);

        let cg_image = match cg_image {
            Some(img) => img,
            None => {
                eprintln!("[capture] CGDisplayCreateImage returned null");
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };

        // Store native dimensions for coordinate scaling
        let native_w = cg_image.width() as u32;
        let native_h = cg_image.height() as u32;
        config.native_width.store(native_w, Ordering::Relaxed);
        config.native_height.store(native_h, Ordering::Relaxed);

        // Extract raw pixel data from CGImage. The data() method internally copies from
        // the CGImage's data provider and returns owned CFData.
        let raw_data = cg_image.data();
        let pixel_bytes = raw_data.bytes();
        let bpp = (cg_image.bits_per_pixel() / 8) as usize;
        let bytes_per_row = cg_image.bytes_per_row();

        // Compute output dimensions after scaling
        let out_w = ((native_w as f64) * scale) as u32;
        let out_h = ((native_h as f64) * scale) as u32;

        if out_w == 0 || out_h == 0 {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        }

        // Scale down and convert BGRA (CoreGraphics native) to RGB for JPEG encoding.
        // Uses nearest-neighbor sampling for maximum speed.
        let rgb_len = (out_w as usize) * (out_h as usize) * 3;
        let mut rgb_buf: Vec<u8> = vec![0u8; rgb_len];

        for y in 0..out_h {
            let src_y = ((y as f64 / scale) as usize).min(native_h as usize - 1);
            let row_offset = src_y * bytes_per_row;
            let dst_row = (y as usize) * (out_w as usize) * 3;
            for x in 0..out_w {
                let src_x = ((x as f64 / scale) as usize).min(native_w as usize - 1);
                let src_offset = row_offset + src_x * bpp;
                let dst_offset = dst_row + (x as usize) * 3;
                if src_offset + 2 < pixel_bytes.len() {
                    // CoreGraphics BGRA byte order -> RGB
                    rgb_buf[dst_offset] = pixel_bytes[src_offset + 2];     // R
                    rgb_buf[dst_offset + 1] = pixel_bytes[src_offset + 1]; // G
                    rgb_buf[dst_offset + 2] = pixel_bytes[src_offset];     // B
                }
            }
        }

        // Frame differencing: only re-encode JPEG if screen content changed
        let hash = fast_hash(&rgb_buf);
        if hash == prev_hash {
            // Screen unchanged - re-publish cached frame at reduced rate (~2 FPS)
            // to keep subscribers alive without wasting bandwidth
            static_frames += 1;
            let idle_interval = (fps / 2).max(1); // send every ~500ms
            if static_frames % idle_interval == 0 {
                if let Some(ref cached) = last_frame {
                    seq += 1;
                    let resend = Frame {
                        data: cached.data.clone(),
                        width: cached.width,
                        height: cached.height,
                        seq,
                    };
                    let _ = tx.send(Some(resend));
                }
            }
        } else {
            prev_hash = hash;
            static_frames = 0;

            // JPEG encode (only when screen actually changed)
            let encode_start = Instant::now();
            let mut jpeg_buf: Vec<u8> = Vec::with_capacity(rgb_len / 4);
            {
                let mut cursor = Cursor::new(&mut jpeg_buf);
                let encoder = JpegEncoder::new_with_quality(&mut cursor, quality as u8);
                if let Err(e) = encoder.write_image(&rgb_buf, out_w, out_h, image::ExtendedColorType::Rgb8) {
                    eprintln!("[capture] JPEG encode error: {}", e);
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
            }
            let encode_elapsed = encode_start.elapsed();
            config
                .encode_ms
                .store(encode_elapsed.as_millis() as u64, Ordering::Relaxed);

            seq += 1;
            let frame = Frame {
                data: Bytes::from(jpeg_buf),
                width: out_w,
                height: out_h,
                seq,
            };

            // Cache this frame for re-sending when screen is static
            last_frame = Some(frame.clone());

            // Publish frame; if no receiver is listening, that is fine
            let _ = tx.send(Some(frame));
        }

        // Pace to target FPS
        let elapsed = frame_start.elapsed();
        let target = Duration::from_millis(1000 / fps as u64);
        if elapsed < target {
            std::thread::sleep(target - elapsed);
        }
    }
}

/// Fast non-cryptographic hash for frame comparison.
/// Samples approximately 4096 evenly spaced bytes from the buffer using
/// FNV-1a to detect changes without hashing every pixel.
fn fast_hash(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325; // FNV-1a offset basis
    let step = (data.len() / 4096).max(1);
    let mut i = 0;
    while i < data.len() {
        h ^= data[i] as u64;
        h = h.wrapping_mul(0x100000001b3); // FNV-1a prime
        i += step;
    }
    h
}

// ---------------------------------------------------------------------------
// Input event handling (CoreGraphics CGEvent)
// ---------------------------------------------------------------------------

/// Parsed input event from the browser client. Tagged union via serde.
#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
#[serde(rename_all = "lowercase")]
enum InputEvent {
    Mousemove {
        x: f64,
        y: f64,
    },
    Mousedown {
        x: f64,
        y: f64,
        button: Option<u8>,
    },
    Mouseup {
        x: f64,
        y: f64,
        button: Option<u8>,
    },
    Dblclick {
        x: f64,
        y: f64,
    },
    Mousedrag {
        x: f64,
        y: f64,
    },
    Scroll {
        x: f64,
        y: f64,
        #[serde(rename = "deltaX", alias = "dx")]
        delta_x: Option<f64>,
        #[serde(rename = "deltaY", alias = "dy")]
        delta_y: Option<f64>,
    },
    Keydown {
        #[serde(rename = "keyCode")]
        key_code: Option<u16>,
        key: Option<String>,
        shift: Option<bool>,
        ctrl: Option<bool>,
        alt: Option<bool>,
        meta: Option<bool>,
    },
    Keyup {
        #[serde(rename = "keyCode")]
        key_code: Option<u16>,
        key: Option<String>,
        shift: Option<bool>,
        ctrl: Option<bool>,
        alt: Option<bool>,
        meta: Option<bool>,
    },
    Config {
        quality: Option<u32>,
        fps: Option<u32>,
        scale: Option<f64>,
    },
}

/// Processes a single input event by posting the corresponding CGEvent to the system.
fn handle_input(event: &InputEvent, config: &SharedConfig) {
    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("[input] failed to create CGEventSource");
            return;
        }
    };

    match event {
        InputEvent::Mousemove { x, y } => {
            post_mouse_move(&source, *x, *y);
        }
        InputEvent::Mousedown { x, y, button } => {
            post_mouse_button(&source, *x, *y, button.unwrap_or(0), true);
        }
        InputEvent::Mouseup { x, y, button } => {
            post_mouse_button(&source, *x, *y, button.unwrap_or(0), false);
        }
        InputEvent::Dblclick { x, y } => {
            post_double_click(&source, *x, *y);
        }
        InputEvent::Mousedrag { x, y } => {
            post_mouse_drag(&source, *x, *y);
        }
        InputEvent::Scroll {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            post_mouse_move(&source, *x, *y);
            let dx = delta_x.unwrap_or(0.0) as i32;
            let dy = delta_y.unwrap_or(0.0) as i32;
            post_scroll(&source, dy, dx);
        }
        InputEvent::Keydown {
            key_code,
            shift,
            ctrl,
            alt,
            meta,
            ..
        } => {
            if let Some(kc) = key_code {
                if let Some(mac_kc) = js_keycode_to_mac(*kc) {
                    post_key_event(
                        &source,
                        mac_kc,
                        true,
                        shift.unwrap_or(false),
                        ctrl.unwrap_or(false),
                        alt.unwrap_or(false),
                        meta.unwrap_or(false),
                    );
                }
            }
        }
        InputEvent::Keyup {
            key_code,
            shift,
            ctrl,
            alt,
            meta,
            ..
        } => {
            if let Some(kc) = key_code {
                if let Some(mac_kc) = js_keycode_to_mac(*kc) {
                    post_key_event(
                        &source,
                        mac_kc,
                        false,
                        shift.unwrap_or(false),
                        ctrl.unwrap_or(false),
                        alt.unwrap_or(false),
                        meta.unwrap_or(false),
                    );
                }
            }
        }
        InputEvent::Config {
            quality,
            fps,
            scale,
        } => {
            if let Some(q) = quality {
                config.quality.store((*q).clamp(1, 100), Ordering::Relaxed);
            }
            if let Some(f) = fps {
                config.fps.store((*f).clamp(1, 60), Ordering::Relaxed);
            }
            if let Some(s) = scale {
                let clamped = s.clamp(0.1, 1.0);
                config
                    .scale_x100
                    .store((clamped * 100.0) as u32, Ordering::Relaxed);
            }
            println!(
                "[config] quality={} fps={} scale={:.2}",
                config.quality.load(Ordering::Relaxed),
                config.fps.load(Ordering::Relaxed),
                config.scale_x100.load(Ordering::Relaxed) as f64 / 100.0
            );
        }
    }
}

/// Posts a CGEvent::MouseMoved to the system event tap.
fn post_mouse_move(source: &CGEventSource, x: f64, y: f64) {
    let point = CGPoint::new(x, y);
    if let Ok(event) = CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::MouseMoved,
        point,
        CGMouseButton::Left,
    ) {
        event.post(CGEventTapLocation::HID);
    }
}

/// Posts a mouse button down or up event at the given coordinates.
fn post_mouse_button(source: &CGEventSource, x: f64, y: f64, button: u8, down: bool) {
    let point = CGPoint::new(x, y);
    let (event_type, cg_button) = match (button, down) {
        (0, true) => (CGEventType::LeftMouseDown, CGMouseButton::Left),
        (0, false) => (CGEventType::LeftMouseUp, CGMouseButton::Left),
        (2, true) => (CGEventType::RightMouseDown, CGMouseButton::Right),
        (2, false) => (CGEventType::RightMouseUp, CGMouseButton::Right),
        (1, true) => (CGEventType::OtherMouseDown, CGMouseButton::Center),
        (1, false) => (CGEventType::OtherMouseUp, CGMouseButton::Center),
        _ => return,
    };
    if let Ok(event) = CGEvent::new_mouse_event(source.clone(), event_type, point, cg_button) {
        event.post(CGEventTapLocation::HID);
    }
}

/// Posts a double-click event by setting the click state field to 2.
fn post_double_click(source: &CGEventSource, x: f64, y: f64) {
    let point = CGPoint::new(x, y);
    if let Ok(event) = CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::LeftMouseDown,
        point,
        CGMouseButton::Left,
    ) {
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 2);
        event.post(CGEventTapLocation::HID);
    }
    if let Ok(event) = CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::LeftMouseUp,
        point,
        CGMouseButton::Left,
    ) {
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 2);
        event.post(CGEventTapLocation::HID);
    }
}

/// Posts a left-mouse-drag event (mouse moved while left button held).
fn post_mouse_drag(source: &CGEventSource, x: f64, y: f64) {
    let point = CGPoint::new(x, y);
    if let Ok(event) = CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::LeftMouseDragged,
        point,
        CGMouseButton::Left,
    ) {
        event.post(CGEventTapLocation::HID);
    }
}

/// Posts a scroll wheel event with pixel-based deltas.
fn post_scroll(source: &CGEventSource, dy: i32, dx: i32) {
    if let Ok(event) =
        CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::PIXEL, 2, dy, dx, 0)
    {
        event.post(CGEventTapLocation::HID);
    }
}

/// Posts a keyboard event (down or up) with the given modifier flags.
fn post_key_event(
    source: &CGEventSource,
    keycode: CGKeyCode,
    down: bool,
    shift: bool,
    ctrl: bool,
    alt: bool,
    meta: bool,
) {
    if let Ok(event) = CGEvent::new_keyboard_event(source.clone(), keycode, down) {
        use core_graphics::event::CGEventFlags;
        let mut flags = event.get_flags();
        if shift {
            flags |= CGEventFlags::CGEventFlagShift;
        }
        if ctrl {
            flags |= CGEventFlags::CGEventFlagControl;
        }
        if alt {
            flags |= CGEventFlags::CGEventFlagAlternate;
        }
        if meta {
            flags |= CGEventFlags::CGEventFlagCommand;
        }
        event.set_flags(flags);
        event.post(CGEventTapLocation::HID);
    }
}

/// Maps JavaScript keyCode values to macOS virtual keycodes.
/// Returns None if no mapping exists for the given keyCode.
fn js_keycode_to_mac(js_code: u16) -> Option<CGKeyCode> {
    // Lazily initialized lookup table: JS keyCode -> macOS virtual keycode
    static JS_TO_MAC: std::sync::LazyLock<HashMap<u16, CGKeyCode>> =
        std::sync::LazyLock::new(|| {
            let mut m = HashMap::new();
            // Letters A-Z (JS 65-90)
            m.insert(65, 0x00); // A
            m.insert(66, 0x0B); // B
            m.insert(67, 0x08); // C
            m.insert(68, 0x02); // D
            m.insert(69, 0x0E); // E
            m.insert(70, 0x03); // F
            m.insert(71, 0x05); // G
            m.insert(72, 0x04); // H
            m.insert(73, 0x22); // I
            m.insert(74, 0x26); // J
            m.insert(75, 0x28); // K
            m.insert(76, 0x25); // L
            m.insert(77, 0x2E); // M
            m.insert(78, 0x2D); // N
            m.insert(79, 0x1F); // O
            m.insert(80, 0x23); // P
            m.insert(81, 0x0C); // Q
            m.insert(82, 0x0F); // R
            m.insert(83, 0x01); // S
            m.insert(84, 0x11); // T
            m.insert(85, 0x20); // U
            m.insert(86, 0x09); // V
            m.insert(87, 0x0D); // W
            m.insert(88, 0x07); // X
            m.insert(89, 0x10); // Y
            m.insert(90, 0x06); // Z
            // Digits 0-9
            m.insert(48, 0x1D); // 0
            m.insert(49, 0x12); // 1
            m.insert(50, 0x13); // 2
            m.insert(51, 0x14); // 3
            m.insert(52, 0x15); // 4
            m.insert(53, 0x17); // 5
            m.insert(54, 0x16); // 6
            m.insert(55, 0x1A); // 7
            m.insert(56, 0x1C); // 8
            m.insert(57, 0x19); // 9
            // Special keys
            m.insert(8, 0x33);   // Backspace
            m.insert(9, 0x30);   // Tab
            m.insert(13, 0x24);  // Enter/Return
            m.insert(16, 0x38);  // Shift (left)
            m.insert(17, 0x3B);  // Control (left)
            m.insert(18, 0x3A);  // Alt/Option (left)
            m.insert(20, 0x39);  // CapsLock
            m.insert(27, 0x35);  // Escape
            m.insert(32, 0x31);  // Space
            m.insert(33, 0x74);  // PageUp
            m.insert(34, 0x79);  // PageDown
            m.insert(35, 0x77);  // End
            m.insert(36, 0x73);  // Home
            m.insert(37, 0x7B);  // ArrowLeft
            m.insert(38, 0x7E);  // ArrowUp
            m.insert(39, 0x7C);  // ArrowRight
            m.insert(40, 0x7D);  // ArrowDown
            m.insert(46, 0x75);  // Delete (forward delete)
            m.insert(91, 0x37);  // Meta/Command (left)
            m.insert(93, 0x37);  // Meta/Command (right, mapped to left)
            // Function keys F1-F12
            m.insert(112, 0x7A); // F1
            m.insert(113, 0x78); // F2
            m.insert(114, 0x63); // F3
            m.insert(115, 0x76); // F4
            m.insert(116, 0x60); // F5
            m.insert(117, 0x61); // F6
            m.insert(118, 0x62); // F7
            m.insert(119, 0x64); // F8
            m.insert(120, 0x65); // F9
            m.insert(121, 0x6D); // F10
            m.insert(122, 0x67); // F11
            m.insert(123, 0x6F); // F12
            // Punctuation and symbol keys
            m.insert(186, 0x29); // ; semicolon
            m.insert(187, 0x18); // = equals
            m.insert(188, 0x2B); // , comma
            m.insert(189, 0x1B); // - minus/hyphen
            m.insert(190, 0x2F); // . period
            m.insert(191, 0x2C); // / forward slash
            m.insert(192, 0x32); // ` grave accent/backtick
            m.insert(219, 0x21); // [ left bracket
            m.insert(220, 0x2A); // \ backslash
            m.insert(221, 0x1E); // ] right bracket
            m.insert(222, 0x27); // ' single quote/apostrophe
            m
        });
    JS_TO_MAC.get(&js_code).copied()
}

// ---------------------------------------------------------------------------
// HTML5 viewer (embedded as a string constant)
// ---------------------------------------------------------------------------

const VIEWER_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remote Desktop</title>
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

body {
    background: #09090b;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    color: #e4e4e7;
    user-select: none;
    -webkit-user-select: none;
}

#toolbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 40px;
    z-index: 100;
    background: rgba(9, 9, 11, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    padding: 0 14px;
    gap: 16px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    opacity: 0;
    transition: opacity 0.15s ease;
}

#toolbar:hover, #toolbar.visible {
    opacity: 1;
}

.status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #ef4444;
    transition: background 0.2s;
    flex-shrink: 0;
}

.status-dot.connected { background: #22c55e; }

#status-text {
    font-size: 12px;
    font-weight: 500;
    color: #a1a1aa;
    min-width: 90px;
}

.divider {
    width: 1px;
    height: 20px;
    background: rgba(255,255,255,0.08);
}

.control-group {
    display: flex;
    align-items: center;
    gap: 6px;
}

.control-group label {
    font-size: 11px;
    color: #71717a;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.control-group select {
    background: rgba(255,255,255,0.06);
    color: #d4d4d8;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s;
}

.control-group select:hover {
    border-color: rgba(255,255,255,0.2);
}

.control-group select:focus {
    border-color: #3b82f6;
}

.toolbar-btn {
    background: rgba(255,255,255,0.06);
    color: #d4d4d8;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    padding: 5px 12px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
}

.toolbar-btn:hover {
    background: rgba(255,255,255,0.1);
    border-color: rgba(255,255,255,0.2);
}

.stats {
    margin-left: auto;
    display: flex;
    gap: 16px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: #71717a;
}

.stat-value {
    color: #a1a1aa;
    font-weight: 600;
}

#canvas-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 100vw;
    height: 100vh;
    background: #09090b;
}

canvas {
    image-rendering: auto;
    max-width: 100vw;
    max-height: 100vh;
    cursor: default;
}

#overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(9, 9, 11, 0.95);
    backdrop-filter: blur(20px);
    transition: opacity 0.3s ease;
}

#overlay.hidden {
    opacity: 0;
    pointer-events: none;
}

.overlay-spinner {
    width: 32px; height: 32px;
    border: 2px solid rgba(255,255,255,0.1);
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 16px;
}

@keyframes spin { to { transform: rotate(360deg); } }

.overlay-text {
    font-size: 14px;
    color: #71717a;
    font-weight: 500;
}
</style>
</head>
<body>

<div id="overlay">
    <div class="overlay-spinner"></div>
    <div class="overlay-text">Connecting...</div>
</div>

<div id="toolbar">
    <div class="status-dot" id="status-dot"></div>
    <span id="status-text">Disconnected</span>

    <div class="divider"></div>

    <div class="control-group">
        <label>Quality</label>
        <select id="ctrl-quality">
            <option value="40">Low</option>
            <option value="60">Medium</option>
            <option value="75" selected>High</option>
            <option value="90">Ultra</option>
        </select>
    </div>

    <div class="control-group">
        <label>FPS</label>
        <select id="ctrl-fps">
            <option value="10">10</option>
            <option value="15">15</option>
            <option value="20" selected>20</option>
            <option value="30">30</option>
        </select>
    </div>

    <div class="control-group">
        <label>Scale</label>
        <select id="ctrl-scale">
            <option value="0.25">25%</option>
            <option value="0.5" selected>50%</option>
            <option value="0.75">75%</option>
            <option value="1.0">100%</option>
        </select>
    </div>

    <button class="toolbar-btn" onclick="toggleFullscreen()">Fullscreen</button>

    <div class="stats">
        <span>FPS: <span class="stat-value" id="stat-fps">--</span></span>
        <span>BW: <span class="stat-value" id="stat-bw">--</span></span>
        <span>Frames: <span class="stat-value" id="stat-frames">--</span></span>
        <span>Size: <span class="stat-value" id="stat-size">--</span></span>
    </div>
</div>

<div id="canvas-wrapper">
    <canvas id="canvas"></canvas>
</div>

<script>
(function() {
    "use strict";

    var canvas = document.getElementById("canvas");
    var ctx = canvas.getContext("2d");
    var overlay = document.getElementById("overlay");
    var statusDot = document.getElementById("status-dot");
    var statusText = document.getElementById("status-text");
    var toolbar = document.getElementById("toolbar");

    var ws = null;
    var streamWidth = 0;
    var streamHeight = 0;
    var scaleX = 1;
    var scaleY = 1;
    var mouseDown = false;
    var frameCount = 0;
    var totalBytes = 0;
    var totalFrames = 0;
    var lastStatTime = performance.now();

    function connect() {
        var proto = location.protocol === "https:" ? "wss:" : "ws:";
        var url = proto + "//" + location.host + "/ws";
        ws = new WebSocket(url);
        ws.binaryType = "blob";

        ws.onopen = function() {
            statusDot.classList.add("connected");
            statusText.textContent = "Connected";
            toolbar.classList.add("visible");
            setTimeout(function() { toolbar.classList.remove("visible"); }, 2500);
            sendConfig();
        };

        ws.onclose = function() {
            statusDot.classList.remove("connected");
            statusText.textContent = "Reconnecting...";
            overlay.classList.remove("hidden");
            setTimeout(connect, 1500);
        };

        ws.onerror = function() {};

        ws.onmessage = function(e) {
            if (!overlay.classList.contains("hidden")) {
                overlay.classList.add("hidden");
            }
            totalBytes += e.data.size;
            totalFrames++;

            var img = new Image();
            var blobUrl = URL.createObjectURL(e.data);
            img.onload = function() {
                if (canvas.width !== img.width || canvas.height !== img.height) {
                    canvas.width = img.width;
                    canvas.height = img.height;
                    streamWidth = img.width;
                    streamHeight = img.height;
                    updateScale();
                    document.getElementById("stat-size").textContent =
                        img.width + "x" + img.height;
                }
                ctx.drawImage(img, 0, 0);
                URL.revokeObjectURL(blobUrl);
                frameCount++;
            };
            img.src = blobUrl;
        };
    }

    function sendConfig() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: "config",
            quality: parseInt(document.getElementById("ctrl-quality").value),
            fps: parseInt(document.getElementById("ctrl-fps").value),
            scale: parseFloat(document.getElementById("ctrl-scale").value)
        }));
    }

    function sendInput(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }

    function updateScale() {
        var rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            scaleX = streamWidth / rect.width;
            scaleY = streamHeight / rect.height;
        }
    }

    function getCoords(e) {
        var rect = canvas.getBoundingClientRect();
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY)
        };
    }

    canvas.addEventListener("mousemove", function(e) {
        var p = getCoords(e);
        if (mouseDown) {
            sendInput({ type: "mousedrag", x: p.x, y: p.y });
        } else {
            sendInput({ type: "mousemove", x: p.x, y: p.y });
        }
    });

    canvas.addEventListener("mousedown", function(e) {
        e.preventDefault();
        mouseDown = true;
        var p = getCoords(e);
        sendInput({ type: "mousedown", button: e.button, x: p.x, y: p.y });
    });

    canvas.addEventListener("mouseup", function(e) {
        e.preventDefault();
        mouseDown = false;
        var p = getCoords(e);
        sendInput({ type: "mouseup", button: e.button, x: p.x, y: p.y });
    });

    canvas.addEventListener("dblclick", function(e) {
        e.preventDefault();
        var p = getCoords(e);
        sendInput({ type: "dblclick", x: p.x, y: p.y });
    });

    canvas.addEventListener("wheel", function(e) {
        e.preventDefault();
        var p = getCoords(e);
        sendInput({
            type: "scroll",
            x: p.x,
            y: p.y,
            deltaX: -e.deltaX,
            deltaY: -e.deltaY
        });
    }, { passive: false });

    canvas.addEventListener("contextmenu", function(e) {
        e.preventDefault();
    });

    document.addEventListener("keydown", function(e) {
        if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
        e.preventDefault();
        sendInput({
            type: "keydown",
            keyCode: e.keyCode,
            key: e.key,
            shift: e.shiftKey,
            ctrl: e.ctrlKey,
            alt: e.altKey,
            meta: e.metaKey
        });
    });

    document.addEventListener("keyup", function(e) {
        if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
        e.preventDefault();
        sendInput({
            type: "keyup",
            keyCode: e.keyCode,
            key: e.key,
            shift: e.shiftKey,
            ctrl: e.ctrlKey,
            alt: e.altKey,
            meta: e.metaKey
        });
    });

    document.addEventListener("keydown", function(e) {
        if (e.key === "Tab") e.preventDefault();
    });

    document.getElementById("ctrl-quality").addEventListener("change", sendConfig);
    document.getElementById("ctrl-fps").addEventListener("change", sendConfig);
    document.getElementById("ctrl-scale").addEventListener("change", sendConfig);

    window.toggleFullscreen = function() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(function() {});
        } else {
            document.exitFullscreen();
        }
    };

    setInterval(function() {
        var now = performance.now();
        var elapsed = (now - lastStatTime) / 1000;
        if (elapsed > 0) {
            var fps = Math.round(frameCount / elapsed);
            var bw = totalBytes / elapsed;
            var bwStr;
            if (bw > 1024 * 1024) {
                bwStr = (bw / (1024 * 1024)).toFixed(1) + " MB/s";
            } else {
                bwStr = Math.round(bw / 1024) + " KB/s";
            }
            document.getElementById("stat-fps").textContent = fps;
            document.getElementById("stat-bw").textContent = bwStr;
            document.getElementById("stat-frames").textContent = totalFrames;
        }
        frameCount = 0;
        totalBytes = 0;
        lastStatTime = now;
    }, 2000);

    window.addEventListener("resize", updateScale);

    connect();
})();
</script>
</body>
</html>"##;

// ---------------------------------------------------------------------------
// TCP server with direct WebSocket and HTTP handling (no hyper)
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    let args = Args::parse();

    println!("Remote Desktop Server (Rust/CoreGraphics)");
    println!("  Port:    {}", args.port);
    println!("  FPS:     {}", args.fps);
    println!("  Quality: {}", args.quality);
    println!("  Scale:   {:.2}", args.scale);
    println!();

    // Shared configuration accessible by capture thread and all WS handlers
    let config = Arc::new(SharedConfig {
        fps: AtomicU32::new(args.fps),
        quality: AtomicU32::new(args.quality),
        scale_x100: AtomicU32::new((args.scale * 100.0) as u32),
        running: AtomicBool::new(true),
        capture_ms: AtomicU64::new(0),
        encode_ms: AtomicU64::new(0),
        native_width: AtomicU32::new(0),
        native_height: AtomicU32::new(0),
    });

    // Frame broadcast channel: capture thread writes, WS handlers read
    let (frame_tx, frame_rx) = watch::channel::<Option<Frame>>(None);

    // Spawn the screen capture thread (OS thread, not tokio task, because CG is blocking)
    let capture_config = Arc::clone(&config);
    std::thread::Builder::new()
        .name("screen-capture".into())
        .spawn(move || {
            capture_loop(frame_tx, capture_config);
        })
        .expect("Failed to spawn capture thread");

    // Wait for the first successful capture to validate screen recording permission
    println!("  Waiting for first screen capture...");
    let mut test_rx = frame_rx.clone();
    let timeout = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            test_rx.changed().await.ok();
            if test_rx.borrow().is_some() {
                break;
            }
        }
    })
    .await;

    match timeout {
        Ok(_) => {
            let f = frame_rx.borrow();
            if let Some(frame) = f.as_ref() {
                println!(
                    "  Screen: {}x{} (native {}x{}) | {} KB/frame | capture {}ms | encode {}ms",
                    frame.width,
                    frame.height,
                    config.native_width.load(Ordering::Relaxed),
                    config.native_height.load(Ordering::Relaxed),
                    frame.data.len() / 1024,
                    config.capture_ms.load(Ordering::Relaxed),
                    config.encode_ms.load(Ordering::Relaxed),
                );
            }
        }
        Err(_) => {
            eprintln!("  ERROR: No screen capture after 5 seconds.");
            eprintln!("  Check System Settings > Privacy & Security > Screen Recording");
            std::process::exit(1);
        }
    }

    let addr: SocketAddr = ([0, 0, 0, 0], args.port).into();
    let listener = TcpListener::bind(addr)
        .await
        .expect("Failed to bind to address");

    println!();
    println!("  Listening on http://0.0.0.0:{}", args.port);
    println!("  Open in browser to connect.");
    println!();

    // Accept loop: peek at first bytes to route between WebSocket and HTTP
    loop {
        let (mut stream, peer_addr) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[server] accept error: {}", e);
                continue;
            }
        };

        let config = Arc::clone(&config);
        let frame_rx = frame_rx.clone();

        tokio::spawn(async move {
            // Peek at the incoming request to determine if it targets /ws
            let mut peek_buf = [0u8; 512];
            let n = match stream.peek(&mut peek_buf).await {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[server] peek error from {}: {}", peer_addr, e);
                    return;
                }
            };

            let header_preview = String::from_utf8_lossy(&peek_buf[..n]);
            let is_ws = header_preview.contains("GET /ws");

            if is_ws {
                // WebSocket: let tokio-tungstenite handle the full handshake
                match tokio_tungstenite::accept_async(stream).await {
                    Ok(ws_stream) => {
                        println!("[ws] client connected: {}", peer_addr);
                        if let Err(e) = run_ws_session(ws_stream, config, frame_rx, peer_addr).await {
                            eprintln!("[ws] session error with {}: {}", peer_addr, e);
                        }
                        println!("[ws] client disconnected: {}", peer_addr);
                    }
                    Err(e) => {
                        eprintln!("[ws] handshake failed for {}: {}", peer_addr, e);
                    }
                }
            } else {
                // Regular HTTP: read the request then serve the HTML viewer
                use tokio::io::AsyncWriteExt;

                // Read and discard the HTTP request (read until \r\n\r\n)
                let mut buf = vec![0u8; 4096];
                let _ = stream.try_read(&mut buf);

                // Build a minimal HTTP response with the viewer HTML
                let body = VIEWER_HTML.as_bytes();
                let response = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: text/html; charset=utf-8\r\n\
                     Content-Length: {}\r\n\
                     Cache-Control: no-cache, no-store\r\n\
                     Connection: close\r\n\
                     \r\n",
                    body.len()
                );

                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.write_all(body).await;
                let _ = stream.flush().await;
            }
        });
    }
}

/// Runs a single WebSocket session: sends frames and receives input events.
async fn run_ws_session<S>(
    ws_stream: tokio_tungstenite::WebSocketStream<S>,
    config: Arc<SharedConfig>,
    frame_rx: watch::Receiver<Option<Frame>>,
    peer: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    // Spawn a task that watches for new frames and sends them to the client
    let mut sender_rx = frame_rx.clone();
    let send_peer = peer;
    let send_task = tokio::spawn(async move {
        let mut last_seq: u64 = 0;
        let mut frames_sent: u64 = 0;
        loop {
            if sender_rx.changed().await.is_err() {
                eprintln!("[ws] frame channel closed for {}", send_peer);
                break;
            }
            let frame = {
                let borrow = sender_rx.borrow();
                borrow.clone()
            };
            if let Some(frame) = frame {
                if frame.seq > last_seq {
                    last_seq = frame.seq;
                    let data_len = frame.data.len();
                    let msg = Message::Binary(frame.data.to_vec());
                    match ws_tx.send(msg).await {
                        Ok(_) => {
                            frames_sent += 1;
                            if frames_sent <= 3 || frames_sent % 100 == 0 {
                                eprintln!("[ws] sent frame #{} ({} bytes, seq {}) to {}", frames_sent, data_len, last_seq, send_peer);
                            }
                        }
                        Err(e) => {
                            eprintln!("[ws] send error to {}: {} (after {} frames)", send_peer, e, frames_sent);
                            break;
                        }
                    }
                }
            }
        }
    });

    // Main loop: receive input events from the client
    while let Some(msg) = ws_rx.next().await {
        match msg {
            Ok(Message::Text(text)) => match serde_json::from_str::<InputEvent>(&text) {
                Ok(event) => handle_input(&event, &config),
                Err(e) => {
                    eprintln!("[ws] parse error from {}: {} -- {}", peer, e, text);
                }
            },
            Ok(Message::Close(_)) => break,
            Err(e) => {
                eprintln!("[ws] recv error from {}: {}", peer, e);
                break;
            }
            _ => {}
        }
    }

    // Clean up the sender task
    send_task.abort();
    let _ = send_task.await;
    Ok(())
}
