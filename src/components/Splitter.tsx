import type React from "react";

type Props = {
  /** "vertical" separates left/right panes (drag horizontally).
   *  "horizontal" separates top/bottom panes (drag vertically). */
  orientation: "vertical" | "horizontal";
  dragging: boolean;
  style?: React.CSSProperties;
  className?: string;
} & Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "style" | "className" | "role" | "aria-orientation"
>;

export function Splitter({
  orientation,
  dragging,
  style,
  className,
  ...rest
}: Props) {
  const cls = [
    "splitter",
    orientation === "vertical" ? "splitter-v" : "splitter-h",
    dragging ? "dragging" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={cls}
      style={style}
      {...rest}
    />
  );
}
