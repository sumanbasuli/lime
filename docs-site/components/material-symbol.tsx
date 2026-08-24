import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface MaterialSymbolProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  size?: number;
  fill?: boolean;
  weight?: 100 | 200 | 300 | 400 | 500 | 600 | 700;
}

export function MaterialSymbol({
  name,
  size = 20,
  fill = false,
  weight = 400,
  className,
  style,
  ...props
}: MaterialSymbolProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("material-symbol shrink-0", className)}
      style={
        {
          fontSize: size,
          fontVariationSettings: `'FILL' ${fill ? 1 : 0}, 'wght' ${weight}, 'GRAD' 0, 'opsz' ${size}`,
          ...style,
        } as CSSProperties
      }
      {...props}
    >
      {name}
    </span>
  );
}
