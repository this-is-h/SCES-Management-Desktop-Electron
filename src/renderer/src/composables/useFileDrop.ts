/**
 * 窗口级文件拖入检测（拖放导入，决策 #12）。
 * - 拖入文件（dataTransfer.types 含 Files）时置 dragging=true，页面显示遮罩；
 * - 用进入/离开计数器避免子元素间的 dragleave 误关；
 * - 松开（drop）回调 onFiles(File[])，由调用方转为本地路径后导入。
 */
import { onMounted, onUnmounted, ref } from 'vue'

export function useFileDrop(onFiles: (files: File[]) => void): { dragging: import('vue').Ref<boolean> } {
  const dragging = ref(false)
  let depth = 0

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
  }

  function onDragEnter(e: DragEvent): void {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth += 1
    dragging.value = true
  }

  function onDragOver(e: DragEvent): void {
    if (!hasFiles(e)) return
    // 阻止浏览器默认“打开文件”行为，允许 drop
    e.preventDefault()
  }

  function onDragLeave(e: DragEvent): void {
    if (!hasFiles(e)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) dragging.value = false
  }

  function onDrop(e: DragEvent): void {
    const files = e.dataTransfer?.files
    if (hasFiles(e)) e.preventDefault()
    depth = 0
    dragging.value = false
    if (files && files.length) {
      onFiles(Array.from(files))
    }
  }

  onMounted(() => {
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
  })

  onUnmounted(() => {
    window.removeEventListener('dragenter', onDragEnter)
    window.removeEventListener('dragover', onDragOver)
    window.removeEventListener('dragleave', onDragLeave)
    window.removeEventListener('drop', onDrop)
    depth = 0
    dragging.value = false
  })

  return { dragging }
}
