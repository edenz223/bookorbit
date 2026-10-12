import { computed, ref, watch, type Ref } from 'vue'
import { ANNOTATION_COLLAPSE_WORDS, countAnnotationWords } from '@bookorbit/types'

export function useAnnotationExpansion(text: Ref<string>, language: Ref<string>) {
  const expanded = ref(false)
  const collapsible = computed(() => countAnnotationWords(text.value, language.value) > ANNOTATION_COLLAPSE_WORDS)
  const collapsed = computed(() => collapsible.value && !expanded.value)

  watch(text, () => {
    expanded.value = false
  })

  function toggleExpanded() {
    expanded.value = !expanded.value
  }

  return { expanded, collapsible, collapsed, toggleExpanded }
}
