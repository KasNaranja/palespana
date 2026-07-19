"use client";

export type SortKey = "total" | "item";

export function SortDropdown({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (v: SortKey) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-texto-2">
      <span className="hidden sm:inline">Ordenar:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        className="rounded-lg border border-borde-fuerte bg-carbon px-2.5 py-1.5 text-sm font-medium text-texto-1 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/25"
      >
        <option value="total">Precio total ↑</option>
        <option value="item">Precio artículo ↑</option>
      </select>
    </label>
  );
}
