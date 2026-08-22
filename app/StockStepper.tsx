"use client";

import { useId } from "react";

export function StockStepper({
  label = "Quantity in shop",
  value,
  onChange,
}: {
  label?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const updateFromInput = (rawValue: string) => {
    if (rawValue === "") {
      onChange(0);
      return;
    }
    const next = Number(rawValue);
    if (Number.isFinite(next)) onChange(Math.max(0, Math.floor(next)));
  };

  return (
    <div className="stock-field">
      <label htmlFor={id}>{label}</label>
      <div className="stock-stepper">
        <button
          type="button"
          aria-label={`Reduce ${label.toLowerCase()} by one`}
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          -
        </button>
        <input
          id={id}
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          enterKeyHint="done"
          value={value === 0 ? "" : value}
          placeholder="0"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => updateFromInput(event.target.value)}
        />
        <button
          type="button"
          aria-label={`Increase ${label.toLowerCase()} by one`}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}
