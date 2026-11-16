import { KNOWN_PROVIDER_KINDS, type ProviderKind } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { providerLabel } from "./format";

export function usageProviderFilterLabel(hidden: ReadonlySet<ProviderKind>): string {
  const visible = KNOWN_PROVIDER_KINDS.filter((provider) => !hidden.has(provider));
  if (visible.length === KNOWN_PROVIDER_KINDS.length) return "All providers";
  if (visible.length === 0) return "No providers";
  if (visible.length === 1) return providerLabel(visible[0]!);
  return `${visible.length} providers`;
}

/** Provider visibility shared by every Usage tab. Stored as the hidden set. */
export function UsageProviderFilter(props: {
  readonly hiddenProviders: ReadonlySet<ProviderKind>;
  readonly onChange: (hiddenProviders: ReadonlyArray<ProviderKind>) => void;
}) {
  const { hiddenProviders } = props;
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" aria-label="Usage providers" />}>
        {usageProviderFilterLabel(hiddenProviders)}
        <ChevronDownIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={hiddenProviders.size === 0}
          closeOnClick={false}
          onCheckedChange={(checked) => props.onChange(checked ? [] : KNOWN_PROVIDER_KINDS)}
        >
          All providers
        </MenuCheckboxItem>
        <MenuSeparator />
        {KNOWN_PROVIDER_KINDS.map((provider) => (
          <MenuCheckboxItem
            key={provider}
            checked={!hiddenProviders.has(provider)}
            closeOnClick={false}
            onCheckedChange={(checked) =>
              props.onChange(
                KNOWN_PROVIDER_KINDS.filter((entry) =>
                  entry === provider ? !checked : hiddenProviders.has(entry),
                ),
              )
            }
          >
            {providerLabel(provider)}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
