/** URL-hash configs ("Copy link to this setup"), screenshots and file downloads. */
import { cloneConfig, defaultConfig } from '../core/defaults';
import type { SimConfig } from '../core/types';

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Deep-merge a partial object onto defaults so old links keep working when fields are added. */
function mergeDefaults<T>(base: T, over: unknown): T {
  if (over === null || over === undefined) return base;
  if (Array.isArray(base)) return (Array.isArray(over) ? over : base) as T;
  if (typeof base === 'object' && base !== null) {
    if (typeof over !== 'object') return base;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = k in out ? mergeDefaults(out[k], v) : v;
    }
    return out as T;
  }
  return (typeof over === typeof base ? over : base) as T;
}

export function encodeConfig(c: SimConfig): string {
  return toBase64Url(JSON.stringify(c));
}

export function decodeConfig(s: string): SimConfig | null {
  try {
    const parsed = JSON.parse(fromBase64Url(s));
    const merged = mergeDefaults(defaultConfig(), parsed);
    // custom courses are free-form
    if (parsed?.course?.custom) merged.course.custom = parsed.course.custom;
    return cloneConfig(merged);
  } catch {
    return null;
  }
}

export function configFromHash(): SimConfig | null {
  const h = typeof location !== 'undefined' ? location.hash : '';
  const m = h.match(/cfg=([^&]+)/);
  return m ? decodeConfig(m[1]) : null;
}

export async function copyLink(c: SimConfig): Promise<boolean> {
  const url = `${location.origin}${location.pathname}#cfg=${encodeConfig(c)}`;
  try {
    history.replaceState(null, '', url);
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

export function download(name: string, content: string | Blob, type = 'text/plain'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function takeScreenshot(): void {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  canvas.toBlob((b) => {
    if (b) download(`c3u-sim-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, b, 'image/png');
  });
}
