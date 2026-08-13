#!/usr/bin/env python3
"""
Lightweight remote desktop server for macOS.
Uses native CoreGraphics JPEG compression (no PIL) for fast capture.
Streams frames over WebSocket, accepts mouse/keyboard input.
"""

import asyncio
import json
import time
import threading
import http.server
import socketserver
import sys

import Quartz
import Quartz.CoreGraphics as CG
import objc
from CoreFoundation import (
    CFDataGetBytes, CFDataGetLength, CFDataCreate,
    kCFAllocatorDefault
)
import websockets

HOST = "0.0.0.0"
WS_PORT = 9876
HTTP_PORT = 9877
TARGET_FPS = 15
JPEG_QUALITY = 0.5
SCALE = 0.5  # Capture at half resolution for speed


def capture_screen_jpeg(quality=JPEG_QUALITY, scale=SCALE):
    """Capture screen using native CoreGraphics JPEG -- no PIL needed."""
    image = CG.CGWindowListCreateImage(
        CG.CGRectInfinite,
        CG.kCGWindowListOptionOnScreenOnly,
        CG.kCGNullWindowID,
        CG.kCGWindowImageDefault
    )
    if not image:
        return None, 0, 0

    w = CG.CGImageGetWidth(image)
    h = CG.CGImageGetHeight(image)

    # Scale down if needed
    if scale < 1.0:
        new_w = int(w * scale)
        new_h = int(h * scale)
        colorspace = CG.CGColorSpaceCreateDeviceRGB()
        context = CG.CGBitmapContextCreate(
            None, new_w, new_h, 8, new_w * 4,
            colorspace, CG.kCGImageAlphaPremultipliedFirst | CG.kCGBitmapByteOrder32Little
        )
        CG.CGContextSetInterpolationQuality(context, CG.kCGInterpolationLow)
        CG.CGContextDrawImage(context, CG.CGRectMake(0, 0, new_w, new_h), image)
        image = CG.CGBitmapContextCreateImage(context)
        w, h = new_w, new_h

    # Use native ImageIO JPEG compression
    mutable_data = Quartz.CFDataCreateMutable(None, 0)
    dest = Quartz.CGImageDestinationCreateWithData(mutable_data, "public.jpeg", 1, None)
    properties = {Quartz.kCGImageDestinationLossyCompressionQuality: quality}
    Quartz.CGImageDestinationAddImage(dest, image, properties)
    Quartz.CGImageDestinationFinalize(dest)

    # Extract bytes
    length = CFDataGetLength(mutable_data)
    buf = bytearray(length)
    CFDataGetBytes(mutable_data, (0, length), buf)

    return bytes(buf), w, h


def mouse_move(x, y):
    e = CG.CGEventCreateMouseEvent(None, CG.kCGEventMouseMoved, CG.CGPointMake(x, y), CG.kCGMouseButtonLeft)
    CG.CGEventPost(CG.kCGHIDEventTap, e)

def mouse_click(x, y, button="left", action="click"):
    btn = CG.kCGMouseButtonLeft if button == "left" else CG.kCGMouseButtonRight
    dt = CG.kCGEventLeftMouseDown if button == "left" else CG.kCGEventRightMouseDown
    ut = CG.kCGEventLeftMouseUp if button == "left" else CG.kCGEventRightMouseUp
    p = CG.CGPointMake(x, y)
    if action in ("click", "down"):
        e = CG.CGEventCreateMouseEvent(None, dt, p, btn)
        CG.CGEventPost(CG.kCGHIDEventTap, e)
    if action in ("click", "up"):
        e = CG.CGEventCreateMouseEvent(None, ut, p, btn)
        CG.CGEventPost(CG.kCGHIDEventTap, e)

def mouse_double_click(x, y):
    p = CG.CGPointMake(x, y)
    e = CG.CGEventCreateMouseEvent(None, CG.kCGEventLeftMouseDown, p, CG.kCGMouseButtonLeft)
    CG.CGEventSetIntegerValueField(e, CG.kCGMouseEventClickState, 2)
    CG.CGEventPost(CG.kCGHIDEventTap, e)
    e = CG.CGEventCreateMouseEvent(None, CG.kCGEventLeftMouseUp, p, CG.kCGMouseButtonLeft)
    CG.CGEventSetIntegerValueField(e, CG.kCGMouseEventClickState, 2)
    CG.CGEventPost(CG.kCGHIDEventTap, e)

def mouse_scroll(x, y, dx, dy):
    mouse_move(x, y)
    e = CG.CGEventCreateScrollWheelEvent(None, CG.kCGScrollEventUnitPixel, 2, int(dy), int(dx))
    CG.CGEventPost(CG.kCGHIDEventTap, e)

def mouse_drag(x, y):
    e = CG.CGEventCreateMouseEvent(None, CG.kCGEventLeftMouseDragged, CG.CGPointMake(x, y), CG.kCGMouseButtonLeft)
    CG.CGEventPost(CG.kCGHIDEventTap, e)

def key_event(keycode, down=True, flags=0):
    e = CG.CGEventCreateKeyboardEvent(None, keycode, down)
    if flags:
        CG.CGEventSetFlags(e, flags)
    CG.CGEventPost(CG.kCGHIDEventTap, e)

def type_string(text):
    for char in text:
        ed = CG.CGEventCreateKeyboardEvent(None, 0, True)
        CG.CGEventKeyboardSetUnicodeString(ed, len(char), char)
        CG.CGEventPost(CG.kCGHIDEventTap, ed)
        eu = CG.CGEventCreateKeyboardEvent(None, 0, False)
        CG.CGEventKeyboardSetUnicodeString(eu, len(char), char)
        CG.CGEventPost(CG.kCGHIDEventTap, eu)

JS_TO_MAC = {
    8:51,9:48,13:36,16:56,17:59,18:58,20:57,27:53,32:49,
    33:116,34:121,35:119,36:115,37:123,38:126,39:124,40:125,46:117,91:55,93:55,
    112:122,113:120,114:99,115:118,116:96,117:97,118:98,119:100,120:101,121:109,122:103,123:111,
    65:0,66:11,67:8,68:2,69:14,70:3,71:5,72:4,73:34,74:38,75:40,76:37,
    77:46,78:45,79:31,80:35,81:12,82:15,83:1,84:17,85:32,86:9,87:13,88:7,89:16,90:6,
    48:29,49:18,50:19,51:20,52:21,53:23,54:22,55:26,56:28,57:25,
    186:41,187:24,188:43,189:27,190:47,191:44,192:50,219:33,220:42,221:30,222:39,
}

def handle_input(msg):
    try:
        d = json.loads(msg)
        t = d.get("type")
        if t == "mousemove": mouse_move(d["x"], d["y"])
        elif t == "mousedown":
            mouse_click(d["x"], d["y"], "right" if d.get("button") == 2 else "left", "down")
        elif t == "mouseup":
            mouse_click(d["x"], d["y"], "right" if d.get("button") == 2 else "left", "up")
        elif t == "dblclick": mouse_double_click(d["x"], d["y"])
        elif t == "scroll": mouse_scroll(d["x"], d["y"], d.get("dx", 0), d.get("dy", 0))
        elif t == "mousedrag": mouse_drag(d["x"], d["y"])
        elif t in ("keydown", "keyup"):
            mk = JS_TO_MAC.get(d.get("keyCode", 0))
            if mk is not None:
                f = 0
                if d.get("shift"): f |= CG.kCGEventFlagMaskShift
                if d.get("ctrl"): f |= CG.kCGEventFlagMaskControl
                if d.get("alt"): f |= CG.kCGEventFlagMaskAlternate
                if d.get("meta"): f |= CG.kCGEventFlagMaskCommand
                key_event(mk, t == "keydown", f)
        elif t == "type": type_string(d.get("text", ""))
    except Exception as e:
        print(f"Input err: {e}", flush=True)


async def stream_handler(websocket):
    print(f"Client connected: {websocket.remote_address}", flush=True)
    quality = JPEG_QUALITY
    scale = SCALE
    fps = TARGET_FPS

    async def send_frames():
        nonlocal quality, scale, fps
        while True:
            try:
                t0 = time.monotonic()
                frame, w, h = capture_screen_jpeg(quality, scale)
                cap_ms = (time.monotonic() - t0) * 1000
                if frame:
                    await websocket.send(frame)
                elapsed = time.monotonic() - t0
                wait = max(0, (1.0 / fps) - elapsed)
                await asyncio.sleep(wait)
            except websockets.exceptions.ConnectionClosed:
                break
            except Exception as e:
                print(f"Frame err: {e}", flush=True)
                await asyncio.sleep(0.1)

    async def recv_input():
        nonlocal quality, scale, fps
        async for msg in websocket:
            try:
                d = json.loads(msg)
                if d.get("type") == "config":
                    quality = d.get("quality", quality)
                    if isinstance(quality, int): quality = quality / 100.0
                    scale = d.get("scale", scale)
                    fps = d.get("fps", fps)
                    print(f"Config: q={quality:.0%} s={scale} fps={fps}", flush=True)
                else:
                    handle_input(msg)
            except Exception as e:
                print(f"Recv err: {e}", flush=True)

    try:
        await asyncio.gather(send_frames(), recv_input())
    except websockets.exceptions.ConnectionClosed:
        print(f"Client disconnected", flush=True)


HTML = r"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mac Mini Remote</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;overflow:hidden;font-family:-apple-system,sans-serif}
#tb{position:fixed;top:0;left:0;right:0;height:36px;z-index:100;
background:rgba(20,20,20,0.95);backdrop-filter:blur(10px);
display:flex;align-items:center;padding:0 12px;gap:12px;
border-bottom:1px solid rgba(255,255,255,0.08);
opacity:0;transition:opacity 0.15s}
#tb:hover,#tb.v{opacity:1}
.st{font-size:12px;font-weight:500}.st.on{color:#4ade80}.st.off{color:#f87171}
#tb label{color:#888;font-size:11px}
#tb select{background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:4px;padding:2px 6px;font-size:11px}
#tb button{background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer}
#tb button:hover{background:#2a2a2a}
.fp{color:#666;font-size:11px;font-variant-numeric:tabular-nums;margin-left:auto}
#wr{display:flex;justify-content:center;align-items:center;width:100vw;height:100vh}
canvas{image-rendering:auto;max-width:100vw;max-height:100vh}
</style></head><body>
<div id="tb">
<span id="st" class="st off">--</span>
<label>Q:<select id="q"><option value="30">Low</option><option value="50">Med</option><option value="60" selected>High</option><option value="80">Max</option></select></label>
<label>FPS:<select id="fp"><option value="10">10</option><option value="15" selected>15</option><option value="20">20</option><option value="30">30</option></select></label>
<button onclick="document.documentElement.requestFullscreen()">FS</button>
<span class="fp" id="fi">-- fps | -- ms</span>
</div>
<div id="wr"><canvas id="c"></canvas></div>
<script>
const W=`ws://${location.hostname}:9876`,c=document.getElementById("c"),x=c.getContext("2d"),
s=document.getElementById("st"),fi=document.getElementById("fi");
let ws,sW=0,sH=0,sX=1,sY=1,fc=0,lt=Date.now(),md=false,bs=0;

function conn(){
ws=new WebSocket(W);ws.binaryType="blob";
ws.onopen=()=>{s.textContent="Connected";s.className="st on";
document.getElementById("tb").classList.add("v");setTimeout(()=>document.getElementById("tb").classList.remove("v"),3000);cfg()};
ws.onclose=()=>{s.textContent="Reconnecting...";s.className="st off";setTimeout(conn,1000)};
ws.onerror=()=>{};
ws.onmessage=e=>{bs+=e.data.size;const i=new Image(),u=URL.createObjectURL(e.data);
i.onload=()=>{if(c.width!==i.width||c.height!==i.height){c.width=i.width;c.height=i.height;sW=i.width;sH=i.height;uS()}
x.drawImage(i,0,0);URL.revokeObjectURL(u);fc++};i.src=u}}

function uS(){const r=c.getBoundingClientRect();sX=sW/r.width;sY=sH/r.height}
function cfg(){if(!ws||ws.readyState!==1)return;ws.send(JSON.stringify({type:"config",
quality:+document.getElementById("q").value,fps:+document.getElementById("fp").value,scale:0.5}))}
function si(d){if(ws&&ws.readyState===1)ws.send(JSON.stringify(d))}
function gc(e){const r=c.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)*sX),y:Math.round((e.clientY-r.top)*sY)}}

c.addEventListener("mousemove",e=>{const p=gc(e);si(md?{type:"mousedrag",...p}:{type:"mousemove",...p})});
c.addEventListener("mousedown",e=>{e.preventDefault();md=true;si({type:"mousedown",button:e.button,...gc(e)})});
c.addEventListener("mouseup",e=>{md=false;si({type:"mouseup",button:e.button,...gc(e)})});
c.addEventListener("dblclick",e=>{e.preventDefault();si({type:"dblclick",...gc(e)})});
c.addEventListener("wheel",e=>{e.preventDefault();si({type:"scroll",dx:-e.deltaX,dy:-e.deltaY,...gc(e)})},{passive:false});
c.addEventListener("contextmenu",e=>e.preventDefault());
document.addEventListener("keydown",e=>{if(e.target.tagName==="SELECT")return;e.preventDefault();
si({type:"keydown",keyCode:e.keyCode,key:e.key,shift:e.shiftKey,ctrl:e.ctrlKey,alt:e.altKey,meta:e.metaKey})});
document.addEventListener("keyup",e=>{if(e.target.tagName==="SELECT")return;e.preventDefault();
si({type:"keyup",keyCode:e.keyCode,key:e.key,shift:e.shiftKey,ctrl:e.ctrlKey,alt:e.altKey,meta:e.metaKey})});
document.getElementById("q").addEventListener("change",cfg);
document.getElementById("fp").addEventListener("change",cfg);

setInterval(()=>{const n=Date.now(),el=(n-lt)/1000;
const f=Math.round(fc/el),kb=Math.round(bs/el/1024);
fi.textContent=f+" fps | "+kb+" KB/s";fc=0;bs=0;lt=n},2000);
window.addEventListener("resize",uS);conn();
</script></body></html>"""


class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type","text/html")
        self.send_header("Cache-Control","no-cache")
        self.end_headers()
        self.wfile.write(HTML.encode())
    def log_message(self,*a):pass


def run_http():
    with socketserver.TCPServer(("0.0.0.0", HTTP_PORT), H) as h:
        h.serve_forever()


async def main():
    print(f"Mac Mini Remote Desktop", flush=True)
    print(f"  WS:   ws://0.0.0.0:{WS_PORT}", flush=True)
    print(f"  HTTP: http://0.0.0.0:{HTTP_PORT}", flush=True)

    t0 = time.monotonic()
    frame, w, h = capture_screen_jpeg()
    ms = (time.monotonic() - t0) * 1000
    if frame:
        print(f"  Screen: {w}x{h} | {len(frame)//1024}KB/frame | {ms:.0f}ms capture", flush=True)
    else:
        print("  ERROR: capture failed!", flush=True)
        return

    threading.Thread(target=run_http, daemon=True).start()
    print(f"\n  Open: http://100.118.228.46:{HTTP_PORT}\n", flush=True)

    async with websockets.serve(stream_handler, HOST, WS_PORT, max_size=10*1024*1024):
        print("  Ready.", flush=True)
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
