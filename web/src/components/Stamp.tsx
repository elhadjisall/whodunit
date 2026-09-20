import { motion } from "framer-motion";
import { useEffect } from "react";
import { sfxStamp } from "../lib/audio";
import { cx } from "../lib/ui";

export type StampTone = "red" | "green" | "blue" | "amber" | "ink";

export function Stamp({
  text,
  tone = "red",
  size = "md",
  rotate = -12,
  className,
  sound = true,
  heavy = false,
  delay = 0,
}: {
  text: string;
  tone?: StampTone;
  size?: "sm" | "md" | "lg" | "xl";
  rotate?: number;
  className?: string;
  sound?: boolean;
  heavy?: boolean;
  delay?: number;
}) {
  useEffect(() => {
    if (!sound) return;
    const t = setTimeout(() => sfxStamp(heavy), delay * 1000 + 120);
    return () => clearTimeout(t);
  }, [sound, heavy, delay]);
  const sizes = { sm: "text-[11px]", md: "text-base", lg: "text-2xl", xl: "text-5xl" } as const;
  return (
    <motion.div
      initial={{ scale: 2.6, opacity: 0, rotate: rotate - 8 }}
      animate={{ scale: 1, opacity: 0.92, rotate }}
      transition={{ type: "spring", stiffness: 520, damping: 20, delay }}
      className={cx("stamp select-none", `stamp-${tone}`, sizes[size], className)}
    >
      {text}
    </motion.div>
  );
}
