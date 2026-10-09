import type { Metadata } from "next";
import { VaultPanel } from "@/components/vault-panel";

export const metadata: Metadata = {
  title: "存储机器人 · 讯栈",
  description: "贴上 @BotFather 的令牌，在 Telegram 里收文件，再用编号取回。",
};

export default function VaultPage() {
  return (
    <div className="desk-canvas flex min-h-dvh">
      <VaultPanel homeHref="/" />
    </div>
  );
}
