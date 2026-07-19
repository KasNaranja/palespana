// The PAL España "mirilla" (crosshair) mark, inline so we can animate it and
// tint it via currentColor. Used as the loading spinner and empty-state mark.
export function Mirilla({
  size = 48,
  spinning = false,
  className = "",
}: {
  size?: number;
  spinning?: boolean;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 160 160"
      fill="none"
      role="img"
      aria-label="PAL España"
      className={[spinning ? "animate-spinPulse" : "", className].join(" ")}
    >
      <circle cx="80" cy="80" r="66" fill="#e63946" opacity="0.08" />
      <circle cx="80" cy="80" r="46" fill="none" stroke="#e63946" strokeWidth="6" />
      <line x1="80" y1="18" x2="80" y2="142" stroke="#e63946" strokeWidth="6" strokeLinecap="round" />
      <line x1="18" y1="80" x2="142" y2="80" stroke="#e63946" strokeWidth="6" strokeLinecap="round" />
      <circle cx="80" cy="80" r="11" fill="#e63946" />
    </svg>
  );
}
