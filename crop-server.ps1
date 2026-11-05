# Hot resident crop server. Started by the Host half at plugin activation;
# stays warm so each screenshot skips the ~460 ms pwsh cold start. Protocol
# on stdin, one JSON line out per command:
#   {"cmd":"shot","hide":bool,"window":"Title","delay":400}
#     -> {"status":"ok",dataBase64,width,height} | {"status":"cancel"}
#   {"cmd":"exit"}
# All interaction logic lives in the compiled DshShot.CropForm (crop-form.cs,
# kept as a separate file so the C# is authored once).
$ErrorActionPreference = 'Stop'
# Pin the console encodings to UTF-8 BEFORE anything reads stdin: the Host
# half writes UTF-8 JSON (the C# source carries Chinese UI strings), and the
# default console code page would mangle both directions.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# Precompile/preload everything expensive ONCE, before the first command.
Add-Type -TypeDefinition @'
namespace Win32
{
    using System;
    using System.Runtime.InteropServices;

    public static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        // Per-Monitor-V2 thread context: each shot re-asserts it so a Windows
        // scale-factor change made while this resident process is running is
        // picked up instead of freezing the DPI virtualization from launch.
        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    }
}
'@
[Win32.Native]::SetProcessDPIAware() | Out-Null
# -4 is the per-monitor-v2 aware context. SetThreadDpiAwarenessContext
# RETURNS the previous context, so it must NOT be stored and reused — the
# first fix did that and switched the thread back to the stale system-aware
# context on every shot. The constant is re-applied directly per shot.
$global:DpiContext = [IntPtr](-4)

$cropCs = Join-Path $env:TEMP 'DshShot.crop-form.cs'
# The C# source rides in on the FIRST stdin command as {"cmd":"loadcs","cs":"..."}
# so the file lives beside the ps1 and edits invalidate nothing extra.

function Out-Json($obj) { $obj | ConvertTo-Json -Compress }

function Read-Command {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { return $null }
    return $line | ConvertFrom-Json
}

function Find-MainWindow([string]$title) {
    # Case-insensitive match: -like is case-sensitive, and titles like
    # "Notepad" would miss a configured "notepad" needle.
    $pattern = '(?i).*' + [regex]::Escape($title) + '.*'
    return Get-Process | Where-Object { $_.MainWindowTitle -match $pattern } | Select-Object -First 1
}

function Hide-Window([IntPtr]$handle, [int]$delay) {
    # SW_HIDE instead of minimize: the window leaves the screen in the same
    # frame with no animation to race, and IsWindowVisible flips false
    # immediately.
    [Win32.Native]::ShowWindowAsync($handle, 0) | Out-Null
    $w = [System.Diagnostics.Stopwatch]::StartNew()
    while ([Win32.Native]::IsWindowVisible($handle) -and $w.ElapsedMilliseconds -lt $delay) { Start-Sleep -Milliseconds 10 }
    # IsWindowVisible reflects the window STATE, not the DWM compositor's
    # output: the compositor can still hold 1-2 stale frames containing the
    # just-hidden window (the "ghost"). ~250 ms (≈15 frames) lets it drain
    # before the capture.
    Start-Sleep -Milliseconds 250
}

function Invoke-Shot([bool]$hide, [string]$title, [int]$delay) {
    # Re-assert the per-monitor-v2 context every shot: a scale change made
    # while the process is resident must not leave the coordinate system
    # frozen at the launch-time factor.
    [Win32.Native]::SetThreadDpiAwarenessContext($global:DpiContext) | Out-Null
    # The handle is captured BEFORE hiding: a hidden window's
    # Process.MainWindowHandle reads back as zero, so the restore must not
    # re-resolve by title after the hide.
    $target = if ($hide) { Find-MainWindow $title } else { $null }
    if ($hide -and ($null -eq $target -or $target.MainWindowHandle -eq [IntPtr]::Zero)) {
        throw ('no matching window for title ' + $title)
    }
    $handle = if ($hide) { $target.MainWindowHandle } else { [IntPtr]::Zero }
    if ($hide) { Hide-Window $handle $delay }
    try {
        # Physical pixels straight from the metrics, not the (possibly
        # stale) Screen.Bounds virtualization.
        $w = [Win32.Native]::GetSystemMetrics(16)  # SM_CXSCREEN
        $h = [Win32.Native]::GetSystemMetrics(17)  # SM_CYSCREEN
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
        $g.Dispose()

        $form = New-Object DshShot.CropForm($bmp)
        [void]$form.ShowDialog()

        if ($form.Ok) {
            $rect = New-Object System.Drawing.Rectangle($form.RX, $form.RY, $form.RW, $form.RH)
            $out = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
            $og = [System.Drawing.Graphics]::FromImage($out)
            $og.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $rect.Width, $rect.Height)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
            $og.Dispose()
            $ms = New-Object System.IO.MemoryStream
            $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            Out-Json @{ status = 'ok'; dataBase64 = [Convert]::ToBase64String($ms.ToArray()); width = $rect.Width; height = $rect.Height }
            $out.Dispose()
        } else {
            Out-Json @{ status = 'cancel' }
        }
        $bmp.Dispose()
        $form.Dispose()
    } finally {
        if ($hide) { [Win32.Native]::ShowWindowAsync($handle, 5) | Out-Null }
    }
}

# Main loop: precompile on the loadcs command, then serve shots.
while ($true) {
    try {
        $cmd = Read-Command
        if ($null -eq $cmd) { break }
        if ($cmd.cmd -eq 'loadcs') {
            Set-Content -Path $cropCs -Value $cmd.cs -Encoding utf8NoBOM
            # The reference set must not depend on which assemblies this
            # particular runtime happens to have loaded: System.Drawing.dll
            # is only a type-forwarding shim, and the real types live in
            # System.Drawing.Primitives / System.Drawing.Common, which are
            # loaded lazily and may be absent from the loaded-set on some
            # .NET versions (the CS1069 Point failure on pwsh/.NET 9).
            # Scan the install directory instead and union it with the
            # loaded framework assemblies; extra references are harmless.
            $refDirs = @($PSHOME, [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory())
            $refAssemblies = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            Get-ChildItem -Path ($refDirs | Select-Object -Unique) -Filter '*.dll' -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^(System|Microsoft\.)' -or $_.Name -match 'netstandard' } |
                ForEach-Object {
                    # Skip native images (System.*.Native.dll etc.): they carry
                    # no managed metadata and the compiler rejects them.
                    try { [void][System.Reflection.AssemblyName]::GetAssemblyName($_.FullName); [void]$refAssemblies.Add($_.FullName) } catch { }
                }
            [System.AppDomain]::CurrentDomain.GetAssemblies() |
                Where-Object { $_.Location } |
                ForEach-Object { [void]$refAssemblies.Add($_.Location) }
            Add-Type -TypeDefinition (Get-Content $cropCs -Raw) -ReferencedAssemblies ([string[]]$refAssemblies)
            Out-Json @{ status = 'ready' }
        } elseif ($cmd.cmd -eq 'shot') {
            Invoke-Shot ([bool]$cmd.hide) ([string]$cmd.window) ([int]$cmd.delay)
        } elseif ($cmd.cmd -eq 'exit') {
            break
        }
    } catch {
        Out-Json @{ status = 'error'; error = ($_.Exception.Message ?? $_.ToString()) }
    }
}
exit 0
