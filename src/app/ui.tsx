/** Small UI primitives (Tailwind). Every control can carry a one-sentence tooltip. */
import { useState, type ReactNode } from 'react';

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

export function Tip({ text, children }: { text?: string; children: ReactNode }) {
  const [show, setShow] = useState(false);
  if (!text) return <>{children}</>;
  return (
    <span className="relative inline-flex" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-1 w-60 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[11px] leading-snug font-normal text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
          {text}
        </span>
      )}
    </span>
  );
}

export function InfoDot({ text }: { text: string }) {
  return (
    <Tip text={text}>
      <span className="ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-slate-400 text-[9px] text-slate-500 dark:border-slate-600 dark:text-slate-400">
        i
      </span>
    </Tip>
  );
}

export function Section({ title, tip, open, onToggle, children, right }: { title: string; tip?: string; open: boolean; onToggle: () => void; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="border-b border-slate-200 dark:border-slate-800">
      <button className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs font-semibold tracking-wide text-slate-700 uppercase hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900" onClick={onToggle}>
        <span className={cx('inline-block w-3 text-slate-400 transition-transform', open && 'rotate-90')}>{'▸'}</span>
        <span>{title}</span>
        {tip && <InfoDot text={tip} />}
        <span className="ml-auto">{right}</span>
      </button>
      {open && <div className="space-y-2.5 px-3 pt-0.5 pb-3">{children}</div>}
    </div>
  );
}

export function Label({ children, tip, value }: { children: ReactNode; tip?: string; value?: ReactNode }) {
  return (
    <div className="flex items-center text-[11px] text-slate-600 dark:text-slate-400">
      <span>{children}</span>
      {tip && <InfoDot text={tip} />}
      {value !== undefined && <span className="tabular ml-auto font-mono text-slate-800 dark:text-slate-200">{value}</span>}
    </div>
  );
}

export function Slider({
  label,
  tip,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled,
}: {
  label: string;
  tip?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <div className={cx(disabled && 'opacity-40')}>
      <Label tip={tip} value={format ? format(value) : value}>
        {label}
      </Label>
      <input type="range" className="w-full" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

export function Select<T extends string | number>({
  label,
  tip,
  value,
  options,
  onChange,
  disabled,
}: {
  label?: string;
  tip?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cx(disabled && 'opacity-40')}>
      {label && <Label tip={tip}>{label}</Label>}
      <select
        className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const opt = options.find((o) => String(o.value) === e.target.value);
          if (opt) onChange(opt.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Toggle({ label, tip, value, onChange, disabled }: { label: string; tip?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-center gap-2 text-[11px] text-slate-700 dark:text-slate-300', disabled && 'cursor-not-allowed opacity-40')}>
      <span
        className={cx('relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors', value ? 'bg-sky-500' : 'bg-slate-300 dark:bg-slate-700')}
        onClick={(e) => {
          e.preventDefault();
          if (!disabled) onChange(!value);
        }}
      >
        <span className={cx('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all', value ? 'left-3.5' : 'left-0.5')} />
      </span>
      <span>{label}</span>
      {tip && <InfoDot text={tip} />}
    </label>
  );
}

export function Button({
  children,
  onClick,
  kind = 'default',
  disabled,
  title,
  small,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  title?: string;
  small?: boolean;
  className?: string;
}) {
  const base = 'inline-flex items-center justify-center gap-1 whitespace-nowrap rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const size = small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs';
  const kinds = {
    default: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800',
    primary: 'bg-sky-600 text-white hover:bg-sky-500',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
    ghost: 'text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800',
  };
  return (
    <button className={cx(base, size, kinds[kind], className)} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Tabs<T extends string>({ value, options, onChange, small }: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-900">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded px-2 font-medium transition-colors',
            small ? 'py-0.5 text-[11px]' : 'py-1 text-xs',
            o.value === value ? 'bg-white text-sky-700 shadow-sm dark:bg-slate-700 dark:text-sky-300' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, unit, tip, tone }: { label: string; value: ReactNode; unit?: string; tip?: string; tone?: 'good' | 'warn' | 'bad' }) {
  const toneCls = tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'bad' ? 'text-rose-600 dark:text-rose-400' : 'text-slate-900 dark:text-slate-100';
  return (
    <div className="rounded border border-slate-200 bg-white/60 px-2 py-1 dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex items-center text-[10px] tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
        {tip && <InfoDot text={tip} />}
      </div>
      <div className={cx('tabular font-mono text-sm', toneCls)}>
        {value}
        {unit && <span className="ml-0.5 text-[10px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'sky' | 'amber' | 'rose' | 'emerald' | 'violet' }) {
  const tones = {
    slate: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    sky: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
    amber: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
    rose: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
    emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
    violet: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300',
  };
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium', tones[tone])}>{children}</span>;
}

export function Card({ title, children, right, className }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-md border border-slate-200 bg-white/70 p-2.5 dark:border-slate-800 dark:bg-slate-900/50', className)}>
      {title && (
        <div className="mb-1.5 flex items-center text-xs font-semibold text-slate-700 dark:text-slate-300">
          {title}
          <span className="ml-auto">{right}</span>
        </div>
      )}
      {children}
    </div>
  );
}

export const fmt = (x: number | undefined, d = 2, unit = ''): string => (x === undefined || !Number.isFinite(x) ? '–' : `${x.toFixed(d)}${unit}`);
export const pct = (x: number | undefined, d = 1): string => (x === undefined || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)}%`);
export const cm = (x: number | undefined, d = 1): string => (x === undefined || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d)} cm`);
