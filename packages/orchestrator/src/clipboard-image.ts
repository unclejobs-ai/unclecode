/**
 * Clipboard image capture — platform-specific shells out to pbpaste / xclip /
 * powershell to grab the current clipboard image and synthesise a
 * WorkShellComposerImageAttachment-equivalent payload.
 *
 * The TUI composer triggers this on a hotkey (Ctrl+V) when the OS-level
 * clipboard contains an image MIME; on text-only clipboards we degrade to
 * the existing text paste path.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";

import type {
  ClipboardImageAttachment,
  ClipboardImageError,
  ClipboardImageResult,
} from "@unclecode/contracts";

export type {
  ClipboardImageAttachment,
  ClipboardImageError,
  ClipboardImageResult,
};

const TARGET_MIME = "image/png";

/**
 * Sentinel returned in the `path` field of every successful capture. The
 * temp file used to materialise PNG bytes is removed before return on macOS
 * and Windows, and Linux never produces a stable path (xclip streams via
 * stdout). Consumers must read bytes from `dataUrl`, not from `path`. The
 * sentinel is kept stable across platforms so downstream code never
 * interprets it as a real filesystem reference.
 */
const CLIPBOARD_PATH_SENTINEL = "(clipboard)";

/**
 * Per-image byte ceiling enforced at capture time so a clipboard payload
 * larger than the eventual TUI gate never crosses base64 encoding. Canonical
 * value lives in packages/config-core/src/defaults.ts (CONFIG_CORE_DEFAULT_*).
 *
 * When multi-image clipboard burst (drag-drop / batch paste) is implemented,
 * the TUI hook cap (MAX_CLIPBOARD_ATTACHMENT_COUNT=5) and the provider
 * defensive backstop already bound the merged list. The capture layer only
 * needs a per-image size gate — the count cap belongs at the hook seam.
 */
const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

function tooLarge(byteLength: number): ClipboardImageResult {
  const mib = (byteLength / (1024 * 1024)).toFixed(1);
  return {
    status: "failed",
    reason: `clipboard image too large at capture (${mib} MiB; max ${MAX_CAPTURE_BYTES / (1024 * 1024)} MiB)`,
  };
}

function captureMacOs(): ClipboardImageResult {
  const dir = mkdtempSync(join(tmpdir(), "uc-clip-"));
  const path = join(dir, "clip.png");
  try {
    execFileSync("pbpaste", ["-Prefer", "image"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return { status: "failed", reason: `pbpaste exec failed: ${(error as Error).message}` };
  }
  try {
    // Path is passed via env attribute, never interpolated into AppleScript source.
    execFileSync(
      "osascript",
      [
        "-e",
        `set p to system attribute "UC_CLIP_PATH"`,
        "-e",
        `set imageData to the clipboard as «class PNGf»`,
        "-e",
        `set f to open for access POSIX file p with write permission`,
        "-e",
        `write imageData to f`,
        "-e",
        `close access f`,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, UC_CLIP_PATH: path },
      },
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    return { status: "no-image", reason: `clipboard does not hold an image: ${(error as Error).message}` };
  }
  if (!existsSync(path)) {
    rmSync(dir, { recursive: true, force: true });
    return { status: "no-image", reason: "no image file produced" };
  }
  const bytes = readFileSync(path);
  rmSync(dir, { recursive: true, force: true });
  if (bytes.length > MAX_CAPTURE_BYTES) {
    return tooLarge(bytes.length);
  }
  return {
    status: "ok",
    attachment: {
      type: "image",
      mimeType: TARGET_MIME,
      dataUrl: `data:${TARGET_MIME};base64,${bytes.toString("base64")}`,
      path: CLIPBOARD_PATH_SENTINEL,
      displayName: "clipboard.png",
    },
  };
}

function captureLinux(): ClipboardImageResult {
  try {
    const bytes = execFileSync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    if (bytes.length === 0) {
      return { status: "no-image", reason: "xclip returned empty buffer" };
    }
    if (bytes.length > MAX_CAPTURE_BYTES) {
      return tooLarge(bytes.length);
    }
    return {
      status: "ok",
      attachment: {
        type: "image",
        mimeType: TARGET_MIME,
        dataUrl: `data:${TARGET_MIME};base64,${bytes.toString("base64")}`,
        path: CLIPBOARD_PATH_SENTINEL,
        displayName: "clipboard.png",
      },
    };
  } catch (error) {
    return { status: "failed", reason: `xclip exec failed: ${(error as Error).message}` };
  }
}

function captureWindows(): ClipboardImageResult {
  const dir = mkdtempSync(join(tmpdir(), "uc-clip-"));
  const path = join(dir, "clip.png");
  // Path passed via env, read inside PowerShell as $env:UC_CLIP_PATH (no string interpolation).
  const ps = "Add-Type -AssemblyName System.Windows.Forms;"
    + "$img = [System.Windows.Forms.Clipboard]::GetImage();"
    + "if ($img -ne $null) { $img.Save($env:UC_CLIP_PATH, [System.Drawing.Imaging.ImageFormat]::Png) } else { exit 1 }";
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, UC_CLIP_PATH: path },
    });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return { status: "no-image", reason: "clipboard does not hold an image" };
  }
  if (!existsSync(path)) {
    rmSync(dir, { recursive: true, force: true });
    return { status: "no-image", reason: "no image file produced" };
  }
  const bytes = readFileSync(path);
  rmSync(dir, { recursive: true, force: true });
  if (bytes.length > MAX_CAPTURE_BYTES) {
    return tooLarge(bytes.length);
  }
  return {
    status: "ok",
    attachment: {
      type: "image",
      mimeType: TARGET_MIME,
      dataUrl: `data:${TARGET_MIME};base64,${bytes.toString("base64")}`,
      path: CLIPBOARD_PATH_SENTINEL,
      displayName: "clipboard.png",
    },
  };
}

export function captureClipboardImage(): ClipboardImageResult {
  switch (platform()) {
    case "darwin":
      return captureMacOs();
    case "linux":
      return captureLinux();
    case "win32":
      return captureWindows();
    default:
      return { status: "unsupported", reason: `clipboard capture not wired for platform ${platform()}` };
  }
}
