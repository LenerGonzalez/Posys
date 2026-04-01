import React from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger";

export type ButtonSize = "sm" | "md" | "lg";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/**
 * Botón base reutilizable (forma redondeada ~25px, variantes de color).
 * Pasá `className` para anular bordes redondeados o ancho (p. ej. headers full-bleed).
 */
export default function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center font-semibold transition-colors " +
    "[&_svg]:shrink-0 [&_svg]:block " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35 focus-visible:ring-offset-2 " +
    "disabled:opacity-50 disabled:pointer-events-none rounded-[25px]";

  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-blue-600 text-white shadow-sm shadow-blue-600/15 hover:bg-blue-700 active:bg-blue-800",
    secondary:
      "bg-slate-100 text-slate-800 border border-slate-200/90 hover:bg-slate-200/90 active:bg-slate-300/80",
    outline:
      "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 active:bg-slate-100",
    ghost: "text-slate-700 hover:bg-slate-100/90 active:bg-slate-200/80",
    danger:
      "bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800",
  };

  const sizes: Record<ButtonSize, string> = {
    sm: "px-3.5 py-1.5 text-xs gap-1.5",
    md: "px-4 py-2 text-sm gap-2",
    lg: "px-5 py-2.5 text-base gap-2",
  };

  return (
    <button
      type={type}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`.trim()}
      {...rest}
    />
  );
}
