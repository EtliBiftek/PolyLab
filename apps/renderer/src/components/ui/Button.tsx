import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "subtle" | "ghost";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  title?: string;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  // claude.ai vocabulary: primary = charcoal pill, subtle = white bordered pill.
  primary: "bg-bg-invert text-txt-invert hover:bg-[#3d3d3a] disabled:bg-bg-invert",
  subtle: "bg-white text-txt-0 hover:bg-bg-2 border border-border shadow-[0_1px_2px_rgba(31,30,29,0.05)]",
  ghost: "text-txt-1 hover:text-txt-0 hover:bg-bg-2",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export function Button({
  variant = "subtle",
  size = "md",
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex select-none items-center justify-center rounded-full font-medium transition
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
        disabled:cursor-not-allowed disabled:opacity-45
        ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
