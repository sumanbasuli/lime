import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface MaterialSymbolProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  name: string;
  size?: number;
}

export function MaterialSymbol({
  name,
  size = 20,
  className,
  style,
  ...props
}: MaterialSymbolProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("material-symbol", className)}
      style={{ fontSize: size, ...style } as CSSProperties}
      {...props}
    >
      {name}
    </span>
  );
}
