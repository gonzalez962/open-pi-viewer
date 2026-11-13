import { translate, type SupportedLocale } from '@shared/i18n';
import { dockerNavigation } from './docker-controller';

export function DockerNavigation({ web, active, locale, onSelect }: { web: boolean; active: boolean; locale: SupportedLocale; onSelect: () => void }) {
  return dockerNavigation([], web).includes('docker') ? <button type="button" className="docker-nav" aria-current={active ? 'page' : undefined} onClick={onSelect}>{translate(locale, 'docker.title')}</button> : null;
}
