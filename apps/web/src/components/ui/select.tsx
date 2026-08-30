"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { CaretDown, Check } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export function SelectControl({
  value,
  options,
  onValueChange,
  placeholder = "Select…",
  ariaLabel,
  disabled = false,
  triggerClassName,
  popupClassName,
}: {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  triggerClassName?: string;
  popupClassName?: string;
}) {
  const items = options.map((option) => ({ value: option.value, label: option.label }));

  return (
    <SelectPrimitive.Root
      value={value}
      items={items}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange(next);
      }}
    >
      <SelectPrimitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          "group/select flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-xs outline-none transition-colors hover:border-foreground/20 focus-visible:border-foreground/35 focus-visible:ring-2 focus-visible:ring-ring/15 data-popup-open:border-foreground/30 disabled:cursor-not-allowed disabled:opacity-50",
          triggerClassName,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} className="min-w-0 flex-1 truncate" />
        <SelectPrimitive.Icon className="shrink-0 text-muted-foreground transition-transform group-data-popup-open/select:rotate-180">
          <CaretDown className="size-3.5" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          side="bottom"
          align="start"
          sideOffset={5}
          className="isolate z-60 outline-none"
        >
          <SelectPrimitive.Popup
            className={cn(
              "max-h-[min(22rem,var(--available-height))] min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl shadow-[var(--surface-shadow)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              popupClassName,
            )}
          >
            <SelectPrimitive.List className="max-h-[min(22rem,var(--available-height))] overflow-y-auto p-1">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="grid cursor-pointer grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-2 rounded-md px-2 py-1.5 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:cursor-not-allowed data-disabled:opacity-40"
                >
                  <span className="min-w-0">
                    <SelectPrimitive.ItemText className="block truncate">{option.label}</SelectPrimitive.ItemText>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  <SelectPrimitive.ItemIndicator className="grid size-4 place-items-center">
                    <Check className="size-3.5" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
