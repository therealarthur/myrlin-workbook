# clipboard-guard.ps1 - Preserve the complete Windows clipboard during UI QA.
# Created: 2026-07-25
#
# The browser acceptance test intentionally exercises Chromium's real clipboard
# implementation. This helper snapshots every advertised Windows clipboard
# format before the test mutates it, keeps the snapshot in this STA process,
# and restores it when the parent closes stdin. Clipboard contents are never
# written to stdout/stderr or persisted to disk.
#
# SPDX-License-Identifier: AGPL-3.0-only

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

function Invoke-ClipboardOperation {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock] $Operation
    )

    $lastError = $null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            return & $Operation
        } catch {
            $lastError = $_
            Start-Sleep -Milliseconds 100
        }
    }
    throw $lastError
}

$source = Invoke-ClipboardOperation {
    [System.Windows.Forms.Clipboard]::GetDataObject()
}

$snapshot = New-Object System.Windows.Forms.DataObject
$formats = @()
if ($null -ne $source) {
    $formats = @($source.GetFormats($false))
    foreach ($format in $formats) {
        # Abort before signalling readiness if any advertised format cannot be
        # captured. A partial snapshot is not safe enough to mutate clipboard.
        $data = $source.GetData($format, $false)
        $snapshot.SetData($format, $false, $data)
    }
}

$capturedFormats = @($snapshot.GetFormats($false))
if ($capturedFormats.Count -ne $formats.Count) {
    throw 'Clipboard snapshot was incomplete; browser acceptance was not started.'
}

[Console]::Out.WriteLine('CLIPBOARD_GUARD_READY')
[Console]::Out.Flush()

try {
    # EOF also releases the guard, so an abruptly terminated Node parent still
    # triggers restoration when Windows closes the inherited stdin pipe.
    [void] [Console]::In.ReadLine()
} finally {
    Invoke-ClipboardOperation {
        if ($formats.Count -eq 0) {
            [System.Windows.Forms.Clipboard]::Clear()
        } else {
            [System.Windows.Forms.Clipboard]::SetDataObject($snapshot, $true)
        }
    }
}
