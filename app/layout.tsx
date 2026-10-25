import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "合成 QKD 事件调查",
  description: "单 Agent 用环境工具调查一场合成 QKD 链路事件。不是真机，也不是协议仿真。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
