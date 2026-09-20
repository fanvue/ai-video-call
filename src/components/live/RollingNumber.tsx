"use client";

// Odometer-style digit roll (each digit is a 0-9 strip translated into view) for viewer counts
// and coin totals that tick up while the fan watches.

type RollingNumberProps = {
  value: number;
  ariaLabel: string;
  className?: string;
};

const OdometerDigit = ({ digit }: { digit: number }) => (
  <span className="relative inline-block h-[1em] w-[0.62em] overflow-hidden align-bottom">
    <span
      className="absolute inset-x-0 top-0 flex flex-col transition-transform duration-500 ease-out"
      style={{ transform: `translateY(-${digit}em)` }}
    >
      {Array.from({ length: 10 }, (_, n) => (
        <span
          key={n}
          className="flex h-[1em] items-center justify-center leading-none"
        >
          {n}
        </span>
      ))}
    </span>
  </span>
);

export const RollingNumber = ({
  value,
  ariaLabel,
  className,
}: RollingNumberProps) => {
  const safeValue = Math.max(0, Math.floor(value));
  const digits = String(safeValue)
    .split("")
    .map((char) => Number(char));

  return (
    <span className={className}>
      <span className="sr-only">{ariaLabel}</span>
      <span aria-hidden="true" className="inline-flex tabular-nums">
        {digits.map((digit, index) => (
          <OdometerDigit key={index} digit={digit} />
        ))}
      </span>
    </span>
  );
};
