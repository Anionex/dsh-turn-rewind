declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'

  export const IconRefreshOutline16: ComponentType<{ size?: number; className?: string }>
  export const Tooltip: ComponentType<{ label: string; side?: string; children: ReactNode }>
  export const Modal: ComponentType<{
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
  }>
  export const Button: ComponentType<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>>
}
