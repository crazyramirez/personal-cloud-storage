<script setup lang="ts">
/**
 * Guía paso a paso para entrar desde fuera de casa con Tailscale ([ADR-0016]). Solo explica: no
 * cambia nada en el servidor. La abren el enlace discreto de las pantallas de entrada y de
 * configuración inicial, y la tarjeta «Acceso desde fuera de casa» de Ajustes.
 */
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const session = useSession();

const SETUP = '/opt/pcloud/current/deploy/linux/setup';
const INSTALL = `sudo bash ${SETUP}/pcloud-install-tailscale.sh --execute`;
const CADDY = `sudo bash ${SETUP}/pcloud-install-caddy.sh --execute`;
const OFF = 'sudo tailscale down';
const DOCS = 'https://github.com/crazyramirez/personal-cloud-storage/blob/main/docs/OPERATIONS.md#4-ter-acceso-desde-internet-tailscale-opcional';

const remote = viaTailscale();
/** Dirección de fuera de casa: la actual si ya se entra por Tailscale; si no, la que tendrá. */
const address = computed(() => {
  if (remote) return window.location.origin;
  const host = (session.localName.value || t('common.serverLocalName')).replace(/\.local$/, '');
  return `https://${host}.${t('tailscale.tailnet')}.ts.net`;
});

interface Step {
  readonly title: string;
  readonly text: string;
  readonly command?: string;
  readonly after?: string;
  readonly link?: { readonly href: string; readonly label: string };
}
const steps = computed<Step[]>(() => [
  { title: t('tailscale.step1Title'), text: t('tailscale.step1Text'), command: INSTALL, after: t('tailscale.step1After') },
  { title: t('tailscale.step2Title'), text: t('tailscale.step2Text'), link: { href: 'https://login.tailscale.com/admin/dns', label: t('tailscale.step2Link') } },
  { title: t('tailscale.step3Title'), text: t('tailscale.step3Text'), link: { href: 'https://login.tailscale.com/admin/machines', label: t('tailscale.step3Link') } },
  { title: t('tailscale.step4Title'), text: t('tailscale.step4Text'), command: CADDY, after: t('tailscale.step4After') },
  { title: t('tailscale.step5Title'), text: t('tailscale.step5Text'), link: { href: 'https://tailscale.com/download', label: t('tailscale.step5Link') } },
  { title: t('tailscale.step6Title'), text: remote ? t('tailscale.step6Here') : t('tailscale.step6Text', { tailnet: t('tailscale.tailnet') }), command: address.value },
  { title: t('tailscale.step7Title'), text: t('tailscale.step7Text') },
]);
const notes = computed(() => ['notePrivate', 'notePublicNames', 'noteSession', 'noteSpeed', 'notePhone', 'noteFamily', 'noteShares', 'noteDependency'].map((key) => t(`tailscale.${key}`)));

// «Copiado» se indica en el propio botón: el aviso flotante quedaría detrás del diálogo modal.
const copied = ref('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = text;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.value = ''), 2000);
  } catch {
    // Sin portapapeles (p. ej. sin HTTPS de confianza): el texto se puede seleccionar a mano.
  }
}

onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => clearTimeout(copiedTimer));

function close(): void {
  dialog.value?.close();
  emit('close');
}
</script>

<template>
  <dialog ref="dialog" class="dlg wide guide" aria-labelledby="ts-title" @cancel.prevent="close" @click.self="close">
    <div class="body">
      <div class="head">
        <h2 id="ts-title">{{ t('tailscale.title') }}</h2>
        <button type="button" class="btn btn-icon btn-ghost" :aria-label="t('common.close')" @click="close"><AppIcon name="close" /></button>
      </div>
      <p class="muted">{{ t('tailscale.lead') }}</p>
      <p v-if="remote" class="notice notice-info"><AppIcon name="check" class="accent" /><span>{{ t('tailscale.alreadyRemote') }}</span></p>

      <section aria-labelledby="ts-need">
        <h3 id="ts-need">{{ t('tailscale.needTitle') }}</h3>
        <ul class="list">
          <li>{{ t('tailscale.need1') }}</li>
          <li>{{ t('tailscale.need2') }}</li>
          <li>{{ t('tailscale.need3') }}</li>
        </ul>
        <p class="muted small">{{ t('tailscale.notOwner') }}</p>
      </section>

      <section aria-labelledby="ts-steps">
        <h3 id="ts-steps">{{ t('tailscale.stepsTitle') }}</h3>
        <ol class="steps">
          <li v-for="(step, index) in steps" :key="index">
            <span class="num" aria-hidden="true">{{ index + 1 }}</span>
            <div class="step">
              <strong>{{ step.title }}</strong>
              <p class="muted">{{ step.text }}</p>
              <div v-if="step.command" class="cmd">
                <code class="selectable">{{ step.command }}</code>
                <button type="button" class="btn btn-ghost copy" @click="copy(step.command)">
                  <AppIcon :name="copied === step.command ? 'check' : 'copy'" :size="16" />{{ copied === step.command ? t('tailscale.copied') : t('tailscale.copy') }}
                </button>
              </div>
              <p v-if="step.after" class="muted small">{{ step.after }}</p>
              <a v-if="step.link" class="ext" :href="step.link.href" target="_blank" rel="noopener noreferrer">{{ step.link.label }}<AppIcon name="external" :size="14" /></a>
            </div>
          </li>
        </ol>
        <p class="notice notice-info"><AppIcon name="info" class="accent" /><span>{{ t('tailscale.aiTip') }}</span></p>
      </section>

      <section aria-labelledby="ts-notes">
        <h3 id="ts-notes">{{ t('tailscale.notesTitle') }}</h3>
        <ul class="list">
          <li v-for="note in notes" :key="note">{{ note }}</li>
          <li>
            {{ t('tailscale.noteOff') }}
            <div class="cmd">
              <code class="selectable">{{ OFF }}</code>
              <button type="button" class="btn btn-ghost copy" @click="copy(OFF)">
                <AppIcon :name="copied === OFF ? 'check' : 'copy'" :size="16" />{{ copied === OFF ? t('tailscale.copied') : t('tailscale.copy') }}
              </button>
            </div>
          </li>
        </ul>
      </section>

      <div class="actions">
        <a class="ext muted small docs" :href="DOCS" target="_blank" rel="noopener noreferrer">{{ t('tailscale.docs') }}<AppIcon name="external" :size="14" /></a>
        <button type="button" class="btn btn-primary" @click="close">{{ t('tailscale.done') }}</button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.guide {
  width: min(640px, calc(100vw - 32px));
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.head .btn-icon {
  margin: -10px -10px 0 0;
  flex-shrink: 0;
}

h3 {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 8px;
}

section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.small {
  font-size: 12px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 18px;
  list-style: disc;
  font-size: 14px;
  line-height: 1.5;
}

.steps {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.steps > li {
  display: flex;
  gap: 12px;
}

.num {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
}

.step {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
  line-height: 1.5;
}

.cmd {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 6px 6px 6px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
}

.cmd code {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  font: 12.5px/1.45 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.copy {
  flex-shrink: 0;
  font-size: 13px;
}

.ext {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
}

.actions {
  align-items: center;
}

.docs {
  margin-right: auto;
}

@media (max-width: 640px) {
  .guide {
    width: 100%;
  }

  .docs {
    align-self: center;
    margin-right: 0;
  }
}
</style>
