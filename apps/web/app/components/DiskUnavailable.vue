<script setup lang="ts">
/**
 * Pantalla de disco no disponible (spec §9.9): claramente distinta de una carpeta vacía.
 * Explica la causa que detectó el StorageGuardian, qué puede hacer el usuario y qué sigue funcionando.
 */
const { status, unreachable, refresh } = useStorage();
const checking = ref(false);

const view = computed<VolumeExplanation>(() =>
  unreachable.value
    ? {
        tone: 'danger',
        title: t('volume.unreachableTitle'),
        lead: t('volume.unreachableLead'),
        steps: [t('volume.unreachableStep1'), t('volume.unreachableStep2'), t('volume.unreachableStep3')],
        effects: [{ ok: false, title: t('volume.unreachableEffectTitle'), text: t('volume.unreachableEffectText') }],
        canBrowse: false,
      }
    : explainVolume(status.value),
);
const issue = computed(() => (unreachable.value ? null : (status.value?.issues[0] ?? null)));
const code = computed(() => (issue.value === null ? null : `${status.value?.state} · ${issue.value.code}`));

async function recheck(): Promise<void> {
  checking.value = true;
  try {
    await refresh();
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <section aria-labelledby="estado-titulo" class="card state" :class="`tone-${view.tone}`">
      <div class="hero">
        <span class="badge"><AppIcon name="drive" :size="38" :stroke="1.6" /></span>
        <div class="text">
          <h1 id="estado-titulo">{{ view.title }}</h1>
          <p class="lead">{{ view.lead }}</p>
        </div>
      </div>

      <dl v-if="issue" class="kv cause">
        <dt>{{ t('volume.cause') }}</dt>
        <dd>{{ serverText(issue.message) }}</dd>
        <dt>{{ t('volume.code') }}</dt>
        <dd class="mono">{{ code }}</dd>
        <dt>{{ t('volume.checked') }}</dt>
        <dd>{{ status ? formatDate(status.checkedAt) : '—' }}</dd>
      </dl>

      <div v-if="view.steps.length > 0" class="steps">
        <h2>{{ t('volume.whatToDo') }}</h2>
        <ol>
          <li v-for="step in view.steps" :key="step">{{ step }}</li>
        </ol>
      </div>

      <div class="actions">
        <button type="button" class="btn btn-primary" :disabled="checking" @click="recheck">
          <AppIcon name="refresh" />{{ checking ? t('volume.checking') : t('volume.recheck') }}
        </button>
        <slot name="actions" />
      </div>
    </section>

    <section v-if="view.effects.length > 0" aria-labelledby="mientras-titulo" class="card">
      <h2 id="mientras-titulo">{{ t('volume.meanwhile') }}</h2>
      <ul class="effects">
        <li v-for="effect in view.effects" :key="effect.title">
          <AppIcon :name="effect.ok ? 'check' : 'pause'" :size="20" :class="effect.ok ? 'ok' : 'muted'" />
          <span><strong>{{ effect.title }}</strong> {{ effect.text }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.wrap {
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.state {
  padding: 32px;
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.tone-danger {
  border-color: var(--danger-border);
}

.tone-warn {
  border-color: var(--warn-border);
}

.hero {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 20px;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  border-radius: 18px;
  flex: none;
  background: var(--surface-2);
  color: var(--muted);
}

.tone-danger .badge {
  background: var(--danger-soft);
  color: var(--danger);
}

.tone-warn .badge {
  background: var(--warn-soft);
  color: var(--warn);
}

.text {
  flex: 1 1 360px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h1 {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

h2 {
  font-size: 15px;
  font-weight: 600;
}

.lead {
  font-size: 15px;
}

.cause {
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--surface-2);
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.steps ol {
  list-style: decimal;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.effects {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.effects li {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

.effects strong {
  font-weight: 600;
}

.ok {
  color: var(--ok);
}
</style>
