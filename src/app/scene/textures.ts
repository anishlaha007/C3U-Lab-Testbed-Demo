/** Procedural canvas textures (offline-safe: no font or image downloads). */
import * as THREE from 'three';

const cache = new Map<string, THREE.Texture>();

export function hazardTexture(): THREE.Texture {
  const key = 'hazard';
  if (cache.has(key)) return cache.get(key)!;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f59e0b';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#1f2937';
  for (let k = -64; k < 128; k += 32) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 16, 0);
    g.lineTo(k + 16 - 64, 64);
    g.lineTo(k - 64, 64);
    g.closePath();
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Round badge with a number or short text (for gate numbers and drone labels). */
export function labelTexture(text: string, bg: string, fg = '#ffffff'): THREE.Texture {
  const key = `label:${text}:${bg}:${fg}`;
  if (cache.has(key)) return cache.get(key)!;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(64, 64, 58, 0, Math.PI * 2);
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.stroke();
  g.fillStyle = fg;
  g.font = `bold ${text.length > 2 ? 44 : 64}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Wide text label (for distances). */
export function textTexture(text: string, color = '#e2e8f0', bg = 'rgba(15,23,42,0.75)'): { tex: THREE.CanvasTexture; aspect: number } {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = 'bold 40px system-ui, sans-serif';
  const w = Math.ceil(g.measureText(text).width) + 28;
  c.width = w;
  c.height = 60;
  const g2 = c.getContext('2d')!;
  g2.fillStyle = bg;
  g2.beginPath();
  g2.roundRect(0, 0, w, 60, 14);
  g2.fill();
  g2.fillStyle = color;
  g2.font = 'bold 40px system-ui, sans-serif';
  g2.textBaseline = 'middle';
  g2.fillText(text, 14, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: w / 60 };
}
