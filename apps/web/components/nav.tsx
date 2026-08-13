"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Panel" },
  { href: "/data", label: "Datos" },
  { href: "/variables", label: "Variables" },
  { href: "/explore", label: "Explorar" },
  { href: "/discovery", label: "Discovery" },
  { href: "/replay", label: "Repetición" },
  { href: "/hypotheses", label: "Hipótesis" },
  { href: "/plugins", label: "Plugins" },
] as const;

export function Nav(): JSX.Element {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-56 shrink-0 flex-col border-r border-base-800 bg-base-900 p-4">
      <div className="mb-8 px-2">
        <div className="text-sm font-semibold tracking-wide text-base-100">Trading Research</div>
        <div className="text-xs text-base-400">Laboratorio · NAS100</div>
      </div>
      <ul className="flex flex-col gap-1">
        {ITEMS.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                  active ? "bg-base-800 text-accent" : "text-base-300 hover:bg-base-850 hover:text-base-100"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto px-2 text-xs text-base-400">
        Todo lo que hace esta interfaz también se puede hacer con <code>pnpm trf --help</code>.
      </div>
    </nav>
  );
}
