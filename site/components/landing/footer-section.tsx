"use client";

import { ArrowUpRight } from "lucide-react";
import { AnimatedWave } from "./animated-wave";
import { NPM, REPO, SPP_POOL, TOKEN, VAULT, contract, demoTx, docs, tx } from "@/lib/links";

const footerLinks = {
  Project: [
    { name: "Repository", href: REPO },
    { name: "README", href: docs.readme },
    { name: "npm: rennpay", href: NPM },
    { name: "Four Claude agents", href: docs.examples },
  ],
  Protocol: [
    { name: "Scheme spec", href: docs.scheme },
    { name: "Vault contract", href: docs.contract },
    { name: "The ledger", href: docs.ledger },
    { name: "x402", href: docs.x402 },
  ],
  "On chain": [
    { name: "Vault", href: contract(VAULT) },
    { name: "Token, RTUSD", href: contract(TOKEN) },
    { name: "SPP pool", href: contract(SPP_POOL) },
    { name: "600 payments, one tx", href: tx(demoTx.scale) },
  ],
  Honest: [
    { name: "Measured limits", href: docs.limits },
    { name: "Known limits", href: docs.notes },
    { name: "Not audited", href: docs.notes, badge: "Testnet" },
  ],
};

const socialLinks = [
  { name: "GitHub", href: REPO },
  { name: "npm", href: NPM },
];

export function FooterSection() {
  return (
    <footer className="relative border-t border-foreground/10">
      {/* Animated wave background */}
      <div className="absolute inset-0 h-64 opacity-20 pointer-events-none overflow-hidden">
        <AnimatedWave />
      </div>

      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Main Footer */}
        <div className="py-16 lg:py-24">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-12 lg:gap-8">
            {/* Brand Column */}
            <div className="col-span-2">
              <a href="#" className="inline-flex items-center gap-2 mb-6">
                <span className="text-2xl font-display">Renn</span>
                <span className="text-xs text-muted-foreground font-mono">v3.3.1</span>
              </a>

              <p className="text-muted-foreground leading-relaxed mb-8 max-w-xs">
                A payment rail for agent-to-agent commerce on Stellar. Off-chain vouchers,
                one netted settlement, and a vault nobody can overdraw.
              </p>

              {/* Social Links */}
              <div className="flex gap-6">
                {socialLinks.map((link) => (
                  <a
                    key={link.name}
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 group"
                  >
                    {link.name}
                    <ArrowUpRight className="w-3 h-3 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                  </a>
                ))}
              </div>
            </div>

            {/* Link Columns */}
            {Object.entries(footerLinks).map(([title, links]) => (
              <div key={title}>
                <h3 className="text-sm font-medium mb-6">{title}</h3>
                <ul className="space-y-4">
                  {links.map((link) => (
                    <li key={link.name}>
                      <a
                        href={link.href}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-2"
                      >
                        {link.name}
                        {"badge" in link && link.badge && (
                          <span className="text-xs px-2 py-0.5 bg-foreground text-background rounded-full">
                            {link.badge}
                          </span>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="py-8 border-t border-foreground/10 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Built for the Rise In x Stellar Pro Hackathon, Istanbul. MIT.
          </p>

          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Stellar testnet, Protocol 28
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
