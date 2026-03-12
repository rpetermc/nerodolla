import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'xyz.nerodolla.wallet',
  appName: 'Nerodolla',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    // For dev: uncomment and point to your machine's IP
    // url: 'http://192.168.1.x:3000',
    // cleartext: true,
  },
  plugins: {
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1a1a2e',
    },
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
  },
  android: {
    // F-Droid compatible: no proprietary Google services
    // buildOptions: { keystorePath: 'nerodolla.keystore', ... }
  },
};

export default config;
