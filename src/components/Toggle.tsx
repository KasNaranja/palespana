"use client";

export function Toggle({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
}) {
  return (
    <label
      htmlFor={id}
      className="inline-flex cursor-pointer select-none items-center gap-2.5"
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={[
          "relative inline-flex h-7 w-12 items-center rounded-full transition",
          checked ? "bg-verdict-es" : "bg-borde-fuerte",
        ].join(" ")}
      >
        <span
          className={[
            "inline-block h-5 w-5 transform rounded-full bg-white shadow transition",
            checked ? "translate-x-6" : "translate-x-1",
          ].join(" ")}
        />
      </button>
      <span className="text-sm font-semibold text-texto-1">{label}</span>
    </label>
  );
}
