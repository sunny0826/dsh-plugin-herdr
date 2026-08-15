// Ambient 声明：dsh-client-ui-primitives（运行时由 web shell 的 ClientModuleLoader
// 提供，打包 external；本地仅编译期契约，与运行时版本解耦）。
// 注意：本文件必须保持 ambient（无顶层 import/export），否则 declare module
// 会被视为"模块增强"并要求模块可解析。
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export function StateDot(p: {
    state: string
    size?: number
    className?: string
  }): import('react').ReactNode
  export function Pill(p: {
    active?: boolean
    className?: string
    children?: import('react').ReactNode
  } & Record<string, unknown>): import('react').ReactNode
  export function Button(p: {
    variant?: string
    size?: string
    icon?: import('react').ReactNode
    children?: import('react').ReactNode
  } & Record<string, unknown>): import('react').ReactNode
  export function TerminalBlock(p: {
    command: string
    cwd?: string
    home?: string
    output?: string
    exitCode?: number
    signal?: string
    running?: boolean
    maxLines?: number
    className?: string
  }): import('react').ReactNode
}
