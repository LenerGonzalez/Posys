import React from "react";

export type PolloBadgeVariant =
  | "gray"
  | "green"
  | "red"
  | "blue"
  | "orange"
  | "purple"
  | "emerald";

const VARIANT: Record<PolloBadgeVariant, string> = {
  gray: "bg-gray-100 text-gray-800 border-gray-200",
  green: "bg-green-100 text-green-800 border-green-200",
  red: "bg-red-100 text-red-800 border-red-200",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
  orange: "bg-orange-100 text-orange-800 border-orange-200",
  purple: "bg-purple-100 text-purple-800 border-purple-200",
  emerald: "bg-emerald-100 text-emerald-900 border-emerald-200",
};

export type PolloBadgeProps = {
  children: React.ReactNode;
  variant?: PolloBadgeVariant;
  className?: string;
  title?: string;
};

/**
 * Badge tipo “pastilla” (no forzado a mayúsculas); para etiquetas de estado o tipo.
 */
export default function PolloBadge({
  children,
  variant = "gray",
  className = "",
  title,
}: PolloBadgeProps) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center rounded-md border px-2 py-0.5 text-xs font-medium ${VARIANT[variant]} ${className}`.trim()}
    >
      {children}
    </span>
  );
}
