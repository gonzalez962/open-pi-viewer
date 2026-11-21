import { useContext, type ComponentProps } from 'react';
import { ConfirmationModal } from './ConfirmationModal';
import { SettingsToastContainer, SettingsToastContext, useToastManager } from '@features/settings/toast';
import '@features/settings/toast/settings-toast.css';
import { DockerView } from '@features/docker/DockerView';

type DockerViewAdapterProps = Pick<ComponentProps<typeof DockerView>, 'locale' | 'controller'>;

export function DockerViewAdapter(props: DockerViewAdapterProps) {
  const ambientToast = useContext(SettingsToastContext);
  const localToast = useToastManager();
  const toast = ambientToast ?? localToast;

  return (
    <SettingsToastContext.Provider value={toast}>
      <DockerView {...props} toast={toast} ConfirmationModal={ConfirmationModal} />
      <SettingsToastContainer />
    </SettingsToastContext.Provider>
  );
}
