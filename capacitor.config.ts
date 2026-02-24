import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.incubator.app',
  appName: 'Incubator Monitor',
  webDir: 'dist',
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_icon_config_sample",
      sound: "beep.wav"
    }
  }
};

export default config;