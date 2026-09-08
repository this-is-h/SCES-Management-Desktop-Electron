import type { DmsApi } from './types'

declare global {
  interface Window {
    api: DmsApi
  }
}
