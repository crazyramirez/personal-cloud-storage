<script setup lang="ts">
useHead({ title: () => t('transfers.pageTitle') });

const { transfers, active, pauseAll, resumeAll, clearFinished } = useTransfers();

type Filter = 'all' | 'active' | 'paused' | 'problem' | 'done';
const filter = ref<Filter>('all');

const groups = computed(() => ({
  all: transfers.value,
  active: transfers.value.filter((item) => item.state === 'uploading' || item.state === 'queued'),
  paused: transfers.value.filter((item) => item.state === 'paused'),
  problem: transfers.value.filter((item) => item.state === 'waiting' || item.state === 'error'),
  done: transfers.value.filter((item) => item.state === 'done' || item.state === 'cancelled'),
}));
const TABS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'transfers.tabAll' },
  { key: 'active', label: 'transfers.tabActive' },
  { key: 'paused', label: 'transfers.tabPaused' },
  { key: 'problem', label: 'transfers.tabProblem' },
  { key: 'done', label: 'transfers.tabDone' },
];
const rows = computed(() => [...groups.value[filter.value]].reverse());

const pending = computed(() => transfers.value.filter((item) => item.state !== 'done' && item.state !== 'cancelled'));
const totalBytes = computed(() => pending.value.reduce((sum, item) => sum + item.size, 0));
const doneBytes = computed(() => pending.value.reduce((sum, item) => sum + item.uploaded, 0));
const speed = computed(() => transfers.value.reduce((sum, item) => sum + (item.state === 'uploading' ? item.speed : 0), 0));
const percent = computed(() => (totalBytes.value === 0 ? 0 : Math.floor((doneBytes.value / totalBytes.value) * 100)));
const uploading = computed(() => transfers.value.filter((item) => item.state === 'uploading').length);
const hasPaused = computed(() => groups.value.paused.length > 0);
const summary = computed(() => {
  if (pending.value.length === 0) return t('transfers.summaryNone');
  if (uploading.value === 0) return active.value.length > 0 ? t('transfers.stateWaiting') : t('transfers.summaryAllPaused');
  return t('transfers.summaryUploading', { n: uploading.value });
});
const summaryMeta = computed(() => {
  if (pending.value.length === 0) return t('transfers.summaryHint');
  const parts = [t('transfers.progress', { done: formatBytes(doneBytes.value), total: formatBytes(totalBytes.value) })];
  if (speed.value > 0) parts.push(formatSpeed(speed.value), formatRemaining((totalBytes.value - doneBytes.value) / speed.value));
  return parts.filter(Boolean).join(' · ');
});
</script>

<template>
  <div class="page">
    <div class="top">
      <div class="heading">
        <h1>{{ t('transfers.title') }}</h1>
        <p class="muted">{{ t('transfers.subtitle') }}</p>
      </div>
      <button v-if="active.length > 0" type="button" class="btn" @click="pauseAll"><AppIcon name="pause" :stroke="1.9" />{{ t('transfers.pauseAll') }}</button>
      <button v-else-if="hasPaused" type="button" class="btn" @click="resumeAll"><AppIcon name="play" :stroke="1.9" />{{ t('transfers.resumeAll') }}</button>
      <button v-if="groups.done.length > 0" type="button" class="btn" @click="clearFinished">{{ t('transfers.clearFinished') }}</button>
      <NuxtLink to="/archivos" class="btn btn-primary"><AppIcon name="upload" :stroke="1.9" />{{ t('transfers.uploadFiles') }}</NuxtLink>
    </div>

    <section :aria-label="t('transfers.globalProgress')" class="card global">
      <div class="line">
        <strong>{{ summary }}</strong>
        <span class="muted meta">{{ summaryMeta }}</span>
        <span v-if="pending.length > 0" class="mono muted pct">{{ percent }}%</span>
      </div>
      <div v-if="pending.length > 0" class="bar big" aria-hidden="true"><span :style="{ width: `${percent}%` }" /></div>
    </section>

    <div v-if="transfers.length > 0" class="tabs">
      <button v-for="tab in TABS" :key="tab.key" type="button" class="tab" :class="{ on: filter === tab.key }" :aria-pressed="filter === tab.key" @click="filter = tab.key">
        {{ t(tab.label) }}<span class="n">{{ groups[tab.key].length }}</span>
      </button>
    </div>

    <ul v-if="rows.length > 0" class="rows">
      <TransferRow v-for="item in rows" :key="item.id" :transfer="item" />
    </ul>
    <p v-else-if="transfers.length > 0" class="none muted">{{ t('transfers.emptyCategory') }}</p>

    <section aria-labelledby="proteccion" class="protect">
      <h2 id="proteccion">{{ t('transfers.protectTitle') }}</h2>
      <ul class="muted">
        <li>{{ t('transfers.protect1') }}</li>
        <li>{{ t('transfers.protect2') }}</li>
        <li>{{ t('transfers.protect3') }}</li>
        <li>{{ t('transfers.protect4') }}</li>
      </ul>
      <p class="muted small">{{ t('transfers.keepTabOpen') }}</p>
    </section>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.heading {
  margin-right: auto;
}

h1 {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

h2 {
  font-size: 14px;
  font-weight: 600;
}

.heading p {
  font-size: 13px;
  margin-top: 2px;
}

.global {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 16px;
}

.line strong {
  font-size: 18px;
  font-weight: 700;
}

.meta {
  font-size: 13px;
}

.pct {
  margin-left: auto;
  font-size: 13px;
}

.bar.big {
  height: 10px;
  border-radius: 5px;
}

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.tab.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.n {
  font-weight: 500;
  opacity: 0.85;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.none {
  padding: 28px;
  border-radius: 14px;
  border: 1px dashed var(--border);
  text-align: center;
}

.protect {
  padding: 16px 18px;
  border-radius: 14px;
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.protect ul {
  list-style: disc;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.small {
  font-size: 12px;
}
</style>
