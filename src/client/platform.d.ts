declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ReactNode } from 'react'

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
    contentClassName?: string
  }>
  export const Button: ComponentType<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>>
}

declare module 'react-dom' {
  import type { ReactNode } from 'react'

  export function createPortal(children: ReactNode, container: Element | DocumentFragment, key?: string | null): ReactNode
}
