/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback, ChangeEvent } from 'react';
import mqtt from 'mqtt';
import { 
  Thermometer, 
  Settings as SettingsIcon, 
  Bell, 
  BellOff, 
  Wifi, 
  WifiOff, 
  RefreshCw, 
  Volume2, 
  Play, 
  Clock,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  Plus,
  History,
  Trash2,
  Droplets
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics } from '@capacitor/haptics';
import { 
  ResponsiveContainer, 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid,
  AreaChart,
  Area
} from 'recharts';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// MQTT Configuration
const MQTT_CONFIG = {
  host: '57f9938c484c4f0f9ad4b79b70ae3bf7.s1.eu.hivemq.cloud',
  port: 8884,
  path: '/mqtt',
  protocol: 'wss' as const,
  username: 'qqqqq',
  password: 'Agash2008',
};

const TOPICS = {
  temp: 'incubator/temp',
  humidity: 'incubator/humidity',
  relayState: 'incubator/relay',
  relayControl: 'incubator/relay/set',
  humidifierState: 'incubator/humidifier',
  humidifierControl: 'incubator/humidifier/set',
  tempHigh: 'incubator/temp/high',
  tempLow: 'incubator/temp/low',
  tempHighSet: 'incubator/temp/high/set',
  tempLowSet: 'incubator/temp/low/set',
  humidityHigh: 'incubator/humidity/high',
  humidityLow: 'incubator/humidity/low',
  humidityHighSet: 'incubator/humidity/high/set',
  humidityLowSet: 'incubator/humidity/low/set',
  fanState: 'incubator/fan',
  fanControl: 'incubator/fan/set',
  fanSpeed: 'incubator/fan/speed',
  fanSpeedControl: 'incubator/fan/speed/set',
};

// Types
type Status = 'LOW' | 'NORMAL' | 'HIGH' | 'DISCONNECTED';

interface HistoryPoint {
  id: string;
  time: string;
  temp: number;
  humidity: number;
  timestamp: number;
}

interface AppSettings {
  alarmEnabled: boolean;
  alarmDuration: number; // in seconds
  alarmDurationUnit: 'seconds' | 'minutes';
  customSoundUrl: string | null;
  lowTempThreshold: number;
  highTempThreshold: number;
  lowHumidityThreshold: number;
  highHumidityThreshold: number;
  vibrateEnabled: boolean;
}

// Native notification
async function notify(title: string, body: string) {
  if (!Capacitor.isNativePlatform()) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/favicon.ico" });
    }
    return;
  }
  
  await LocalNotifications.schedule({
    notifications: [
      { 
        title, 
        body, 
        id: 1, // Use fixed ID for the alarm to overwrite previous ones
        sound: 'alarm.wav', // Assuming a sound file exists in native assets
        actionTypeId: 'ALARM_ACTIONS',
        extra: { type: 'alarm' }
      }
    ],
  });
}

export default function App() {
  // State
  const [temp, setTemp] = useState<number | null>(null);
  const [prevTemp, setPrevTemp] = useState<number | null>(null);
  const [humidity, setHumidity] = useState<number | null>(null);
  const [prevHumidity, setPrevHumidity] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>('DISCONNECTED');
  const [humidityStatus, setHumidityStatus] = useState<Status>('DISCONNECTED');
  const [relayState, setRelayState] = useState<'ON' | 'OFF'>('OFF');
  const [humidifierState, setHumidifierState] = useState<'ON' | 'OFF'>('OFF');
  const [fanState, setFanState] = useState<'ON' | 'OFF'>('OFF');
  const [fanSpeed, setFanSpeed] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<'home' | 'settings' | 'history'>('home');
  const [history, setHistory] = useState<HistoryPoint[]>(() => {
    const saved = localStorage.getItem('incubator_history');
    if (!saved) return [];
    try {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) return [];
      // Sanitize: ensure unique IDs and consistent fields for all existing points
      return parsed.map((p, i) => ({
        ...p,
        id: p.id || `${p.timestamp || Date.now()}-${i}-${Math.random().toString(36).substr(2, 9)}`,
        temp: p.temp ?? p.value ?? 0,
        humidity: p.humidity ?? 0,
        timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now()
      }));
    } catch (e) {
      return [];
    }
  });

  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('incubator_settings');
    const defaults: AppSettings = {
      alarmEnabled: true,
      alarmDuration: 30,
      alarmDurationUnit: 'seconds',
      customSoundUrl: null,
      lowTempThreshold: 37.0,
      highTempThreshold: 38.0,
      lowHumidityThreshold: 45,
      highHumidityThreshold: 65,
      vibrateEnabled: true,
    };
    if (saved) {
      try {
        return { ...defaults, ...JSON.parse(saved), customSoundUrl: null };
      } catch (e) {
        return defaults;
      }
    }
    return defaults;
  });
  const [isAlarmActive, setIsAlarmActive] = useState(false);
  const [isSnoozed, setIsSnoozed] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [controlMode, setControlMode] = useState<'AUTO' | 'MANUAL'>('AUTO');

  // Remote thresholds from MQTT
  const [remoteHighTemp, setRemoteHighTemp] = useState<number | null>(null);
  const [remoteLowTemp, setRemoteLowTemp] = useState<number | null>(null);
  const [remoteHighHumidity, setRemoteHighHumidity] = useState<number | null>(null);
  const [remoteLowHumidity, setRemoteLowHumidity] = useState<number | null>(null);

  // Refs for latest values to avoid stale closures in MQTT handler
  const latestTempRef = useRef<number | null>(null);
  const latestHumidityRef = useRef<number | null>(null);
  const settingsRef = useRef<AppSettings>(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    latestTempRef.current = temp;
  }, [temp]);

  useEffect(() => {
    latestHumidityRef.current = humidity;
  }, [humidity]);

  // Persistence
  useEffect(() => {
    const toSave = { ...settings, customSoundUrl: null };
    localStorage.setItem('incubator_settings', JSON.stringify(toSave));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('incubator_history', JSON.stringify(history.slice(-100))); // Keep last 100 points
  }, [history]);
  
  const unlockAudio = useCallback(() => {
    if (audioRef.current && !isAudioUnlocked) {
      audioRef.current.play().then(() => {
        audioRef.current?.pause();
        if (audioRef.current) audioRef.current.currentTime = 0;
        setIsAudioUnlocked(true);
      }).catch(e => {
        console.error("Audio unlock failed", e);
        setIsAudioUnlocked(false);
      });
    }
  }, [isAudioUnlocked]);

  useEffect(() => {
    const handleGlobalClick = () => {
      unlockAudio();
    };
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, [unlockAudio]);

  // Refs
  const mqttClient = useRef<mqtt.MqttClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alarmTimerRef = useRef<NodeJS.Timeout | null>(null);
  const vibrationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const debounceTimers = useRef<{ [key: string]: NodeJS.Timeout }>({});
  const [mqttError, setMqttError] = useState<string | null>(null);

  // Debounce MQTT publishing to prevent broker overload on slider drag
  const debouncedPublish = useCallback((topic: string, message: string, delay: number = 1500) => {
    if (debounceTimers.current[topic]) {
      clearTimeout(debounceTimers.current[topic]);
    }
    debounceTimers.current[topic] = setTimeout(() => {
      if (mqttClient.current?.connected) {
        console.log(`[MQTT] Publishing to ${topic}: ${message}`);
        mqttClient.current.publish(topic, message, { qos: 0, retain: false });
      }
    }, delay);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      Object.values(debounceTimers.current).forEach(clearTimeout);
    };
  }, []);

  // 🔔 Alarm Control
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    setIsSnoozed(true); // Prevent immediate re-trigger
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (alarmTimerRef.current) {
      clearTimeout(alarmTimerRef.current);
    }
    if (vibrationIntervalRef.current) {
      clearInterval(vibrationIntervalRef.current);
    }
    
    // Dismiss notification if active
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.cancel({ notifications: [{ id: 1 }] });
    }
  }, []);

  // 🔔 Notification Actions & Foreground Service
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.requestPermissions();
      
      // Register actions
      LocalNotifications.registerActionTypes({
        types: [
          {
            id: 'ALARM_ACTIONS',
            actions: [
              { id: 'mute', title: 'Mute Alarm', foreground: true }
            ]
          }
        ]
      });

      // Listen for actions
      const actionListenerPromise = LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        if (action.actionId === 'mute') {
          stopAlarm();
        }
      });

      return () => {
        actionListenerPromise.then(h => h.remove());
      };
    } else if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, [stopAlarm]);

  // 🚀 Foreground service (keeps app alive)
  useEffect(() => {
    if (Capacitor.getPlatform() === "android") {
      // Attempt to start foreground service if plugin exists
      // @ts-ignore
      const fgService = window.cordova?.plugins?.foregroundService || window.Capacitor?.Plugins?.ForegroundService;
      if (fgService) {
        fgService.start("Incubator Monitor", "Monitoring temperature in background", "notification_icon", 1);
      }
    }
  }, []);

  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  // MQTT Connection Logic
  useEffect(() => {
    console.log('[MQTT] Connecting to broker...');
    const client = mqtt.connect(`wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`, {
      username: MQTT_CONFIG.username,
      password: MQTT_CONFIG.password,
      clientId: `incubator_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 30000,
      reconnectPeriod: 5000,
      keepalive: 60,
      reschedulePings: true,
    });

    mqttClient.current = client;

    client.on('connect', () => {
      setIsConnected(true);
      setIsReconnecting(false);
      setErrorMsg(null);
      client.subscribe([
        TOPICS.temp, 
        TOPICS.humidity, 
        TOPICS.relayState,
        TOPICS.humidifierState,
        TOPICS.tempHigh,
        TOPICS.tempLow,
        TOPICS.humidityHigh,
        TOPICS.humidityLow,
        TOPICS.fanState,
        TOPICS.fanSpeed
      ]);
    });

    client.on('error', (err) => {
      if (err.message !== 'client disconnecting') {
        console.error('MQTT Error:', err);
        setErrorMsg(err.message);
      }
      setIsConnected(false);
    });

    client.on('close', () => {
      setIsConnected(false);
      setErrorMsg('Connection closed');
    });

    client.on('offline', () => {
      setIsConnected(false);
      setErrorMsg('Broker offline');
    });

    client.on('reconnect', () => {
      setIsReconnecting(true);
      setIsConnected(false);
      setErrorMsg(null);
    });

    client.on('message', (topic, message) => {
      const payload = message.toString();
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const currentSettings = settingsRef.current;

      if (topic === TOPICS.temp) {
        const newTemp = parseFloat(payload);
        // Ignore sensor errors (common values like -127 or extreme negatives)
        if (isNaN(newTemp) || newTemp < -50) return;

        setTemp(current => {
          setPrevTemp(current);
          return newTemp;
        });
        setPulseKey(k => k + 1);
        
        // Add to history
        setHistory(prev => {
          const h = latestHumidityRef.current !== null ? latestHumidityRef.current : 0;
          const newPoint = { 
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            time: timeStr, 
            temp: newTemp,
            humidity: h,
            timestamp: Date.now() 
          };
          // If the last point was added less than 2 seconds ago, update it instead of adding new
          if (prev.length > 0 && Date.now() - prev[prev.length - 1].timestamp < 2000) {
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), { ...last, temp: newTemp, time: timeStr }];
          }
          return [...prev, newPoint].slice(-100);
        });

        // Derive status relative to thresholds
        if (newTemp < currentSettings.lowTempThreshold) setStatus('LOW');
        else if (newTemp > currentSettings.highTempThreshold) setStatus('HIGH');
        else setStatus('NORMAL');
      }

      if (topic === TOPICS.humidity) {
        const newHumidity = parseFloat(payload);
        if (isNaN(newHumidity)) return;

        setHumidity(current => {
          setPrevHumidity(current);
          return newHumidity;
        });
        
        // Add to history
        setHistory(prev => {
          const t = latestTempRef.current !== null ? latestTempRef.current : 0;
          const newPoint = { 
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            time: timeStr, 
            temp: t,
            humidity: newHumidity,
            timestamp: Date.now() 
          };
          // If the last point was added less than 2 seconds ago, update it instead of adding new
          if (prev.length > 0 && Date.now() - prev[prev.length - 1].timestamp < 2000) {
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), { ...last, humidity: newHumidity, time: timeStr }];
          }
          return [...prev, newPoint].slice(-100);
        });

        // Derive status
        if (newHumidity < currentSettings.lowHumidityThreshold) setHumidityStatus('LOW');
        else if (newHumidity > currentSettings.highHumidityThreshold) setHumidityStatus('HIGH');
        else setHumidityStatus('NORMAL');
      }

      if (topic === TOPICS.relayState) {
        setRelayState(payload.toUpperCase() === 'ON' ? 'ON' : 'OFF');
      }

      if (topic === TOPICS.humidifierState) {
        setHumidifierState(payload.toUpperCase() === 'ON' ? 'ON' : 'OFF');
      }

      if (topic === TOPICS.tempHigh) {
        const val = parseFloat(payload);
        if (!isNaN(val)) {
          setRemoteHighTemp(val);
          setSettings(s => ({ ...s, highTempThreshold: val }));
        }
      }

      if (topic === TOPICS.tempLow) {
        const val = parseFloat(payload);
        if (!isNaN(val)) {
          setRemoteLowTemp(val);
          setSettings(s => ({ ...s, lowTempThreshold: val }));
        }
      }

      if (topic === TOPICS.humidityHigh) {
        const val = parseFloat(payload);
        if (!isNaN(val)) {
          setRemoteHighHumidity(val);
          setSettings(s => ({ ...s, highHumidityThreshold: val }));
        }
      }

      if (topic === TOPICS.humidityLow) {
        const val = parseFloat(payload);
        if (!isNaN(val)) {
          setRemoteLowHumidity(val);
          setSettings(s => ({ ...s, lowHumidityThreshold: val }));
        }
      }

      if (topic === TOPICS.fanState) {
        setFanState(payload.toUpperCase() === 'ON' ? 'ON' : 'OFF');
      }

      if (topic === TOPICS.fanSpeed) {
        const val = parseInt(payload);
        if (!isNaN(val)) {
          setFanSpeed(val);
        }
      }
    });

    client.on('close', () => {
      setIsConnected(false);
      setStatus('DISCONNECTED');
    });

    mqttClient.current = client;

    return () => {
      if (client) {
        client.end(true);
        mqttClient.current = null;
      }
    };
  }, [reconnectTrigger]);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive || isSnoozed) return;

    setIsAlarmActive(true);
    
    // Play sound
    if (audioRef.current) {
      audioRef.current.play().then(() => {
        setIsAudioUnlocked(true);
      }).catch(e => {
        // Only log if it's not the interaction error, or handle it silently
        if (e.name !== 'NotAllowedError') {
          console.error("Audio playback failed", e);
        }
        setIsAudioUnlocked(false);
      });
    }

    // Vibrate logic
    if (settings.vibrateEnabled) {
      const vibrate = async () => {
        if (Capacitor.isNativePlatform()) {
          await Haptics.vibrate({ duration: 1000 });
        }
      };
      vibrate();
      vibrationIntervalRef.current = setInterval(vibrate, 2000);
    }

    // Push Notification
    const alertBody = `Temp: ${temp}°C (${status}), Humidity: ${humidity}% (${humidityStatus}). Check the incubator immediately.`;
    if (Capacitor.isNativePlatform()) {
      await LocalNotifications.schedule({
        notifications: [
          { 
            title: "🚨 Incubator Alert!", 
            body: alertBody, 
            id: 1,
            sound: 'alarm.wav', 
            ongoing: true, // Make it persistent
            autoCancel: false,
            actionTypeId: 'ALARM_ACTIONS',
            extra: { type: 'alarm' }
          }
        ],
      });
    } else {
      await notify("🚨 Incubator Alert!", alertBody);
    }

    // Auto stop after duration
    const durationMs = settings.alarmDurationUnit === 'minutes' 
      ? settings.alarmDuration * 60 * 1000 
      : settings.alarmDuration * 1000;
    
    alarmTimerRef.current = setTimeout(stopAlarm, durationMs);
  }, [settings, isAlarmActive, isSnoozed, temp, status, stopAlarm]);

  // Monitor Temp & Humidity for Alarms
  useEffect(() => {
    if (temp !== null || humidity !== null) {
      const isTempOut = temp !== null && (temp < settings.lowTempThreshold || temp > settings.highTempThreshold);
      const isHumidityOut = humidity !== null && (humidity < settings.lowHumidityThreshold || humidity > settings.highHumidityThreshold);
      
      if (isTempOut || isHumidityOut) {
        triggerAlarm();
      } else {
        // Automatically stop alarm if it's currently active and everything is back in range
        if (isAlarmActive) {
          stopAlarm();
        }
        // Reset snooze if everything returns to normal
        setIsSnoozed(false);
      }
    }
  }, [temp, humidity, triggerAlarm, settings.lowTempThreshold, settings.highTempThreshold, settings.lowHumidityThreshold, settings.highHumidityThreshold, isAlarmActive, stopAlarm]);

  // UI Helpers
  const getStatusColor = (s: Status) => {
    switch (s) {
      case 'LOW': return 'text-blue-500';
      case 'NORMAL': return 'text-emerald-500';
      case 'HIGH': return 'text-red-500';
      default: return 'text-zinc-400';
    }
  };

  const getStatusBg = (s: Status) => {
    switch (s) {
      case 'LOW': return 'bg-blue-500/10';
      case 'NORMAL': return 'bg-emerald-500/10';
      case 'HIGH': return 'bg-red-500/10';
      default: return 'bg-zinc-500/10';
    }
  };

  const handleSoundUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setSettings(prev => ({ ...prev, customSoundUrl: url }));
    }
  };

  const testAlarm = () => {
    if (audioRef.current) {
      audioRef.current.play().then(() => {
        setIsAudioUnlocked(true);
        setTimeout(() => {
          audioRef.current?.pause();
          if (audioRef.current) audioRef.current.currentTime = 0;
        }, 3000);
      }).catch(e => {
        console.error("Test playback failed", e);
        setIsAudioUnlocked(false);
      });
    }
    if (Capacitor.isNativePlatform()) {
      Haptics.vibrate({ duration: 500 });
    }
  };

  const toggleRelay = () => {
    if (!mqttClient.current?.connected) return;
    const newState = relayState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.relayControl, newState);
    
    // If user manually toggles, we might want to suggest switching to manual mode
    // or automatically switch to manual mode if that's the desired behavior.
  };

  const setMode = (mode: 'AUTO' | 'MANUAL') => {
    if (!mqttClient.current?.connected) return;
    setControlMode(mode);
    mqttClient.current.publish('incubator/mode/set', mode);
  };

  const toggleHumidifier = () => {
    if (!mqttClient.current?.connected) return;
    const newState = humidifierState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.humidifierControl, newState);
  };

  const toggleFan = () => {
    if (!mqttClient.current?.connected) return;
    const newState = fanState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.fanControl, newState);
  };

  const updateFanSpeed = (speed: number) => {
    setFanSpeed(speed);
    debouncedPublish(TOPICS.fanSpeedControl, speed.toString());
  };

  const updateTempThresholds = (low: number, high: number) => {
    // Ensure logical consistency
    const safeLow = Math.min(low, high - 0.1);
    const safeHigh = Math.max(high, low + 0.1);
    
    setSettings(s => ({ ...s, lowTempThreshold: safeLow, highTempThreshold: safeHigh }));
    
    // Only publish if the value actually changed
    if (safeLow !== settings.lowTempThreshold) {
      debouncedPublish(TOPICS.tempLowSet, safeLow.toFixed(1));
    }
    if (safeHigh !== settings.highTempThreshold) {
      debouncedPublish(TOPICS.tempHighSet, safeHigh.toFixed(1));
    }
  };

  const updateHumidityThresholds = (low: number, high: number) => {
    const safeLow = Math.min(low, high - 1);
    const safeHigh = Math.max(high, low + 1);
    
    setSettings(s => ({ ...s, lowHumidityThreshold: safeLow, highHumidityThreshold: safeHigh }));
    
    if (safeLow !== settings.lowHumidityThreshold) {
      debouncedPublish(TOPICS.humidityLowSet, safeLow.toFixed(1));
    }
    if (safeHigh !== settings.highHumidityThreshold) {
      debouncedPublish(TOPICS.humidityHighSet, safeHigh.toFixed(1));
    }
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('incubator_history');
  };

  const reconnectMqtt = () => {
    setReconnectTrigger(prev => prev + 1);
    setIsConnected(false);
    setIsReconnecting(true);
    setErrorMsg('Manually reconnecting...');
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Hidden Audio Element */}
      <audio 
        ref={audioRef} 
        src={settings.customSoundUrl || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3'} 
        loop 
      />

      {/* Main Container */}
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative overflow-hidden">
        
        {/* Header */}
        <header className="p-4 flex justify-between items-center border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center space-x-3">
            <div className={cn(
              "p-2 rounded-xl transition-colors duration-500", 
              isConnected ? "bg-emerald-500/10" : isReconnecting ? "bg-amber-500/10" : "bg-red-500/10"
            )}>
              {isConnected ? (
                <Wifi className="w-5 h-5 text-emerald-500" />
              ) : isReconnecting ? (
                <motion.div
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ repeat: Infinity, duration: 1 }}
                >
                  <Wifi className="w-5 h-5 text-amber-500" />
                </motion.div>
              ) : (
                <WifiOff className="w-5 h-5 text-red-500" />
              )}
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight leading-tight">Incubator</h1>
              <p className={cn(
                "text-[8px] font-mono uppercase tracking-widest transition-colors duration-500", 
                isConnected ? "text-emerald-500" : isReconnecting ? "text-amber-500" : "text-red-500"
              )}>
                {isConnected ? 'Connected' : isReconnecting ? 'Reconnecting...' : errorMsg || 'Disconnected'}
              </p>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <button 
              onClick={unlockAudio}
              className={cn(
                "p-2 rounded-xl transition-all duration-500 relative",
                !isAudioUnlocked && isAlarmActive ? "bg-red-500 text-white animate-bounce scale-110 shadow-[0_0_20px_rgba(239,68,68,0.5)]" :
                isAudioUnlocked ? "bg-zinc-800 text-zinc-400" : "bg-red-500/20 text-red-500 animate-pulse"
              )}
              title={isAudioUnlocked ? "Audio Alerts Enabled" : "Click to Enable Audio Alerts"}
            >
              {isAudioUnlocked ? <Volume2 className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
              {!isAudioUnlocked && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full border border-zinc-950" />
              )}
            </button>

            <button 
              onClick={() => setActiveTab(activeTab === 'home' ? 'settings' : 'home')}
              className="p-2 rounded-xl hover:bg-zinc-800 transition-colors"
            >
              {activeTab === 'home' ? <SettingsIcon className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-4 overflow-y-auto pb-20">
          <AnimatePresence mode="wait">
            {activeTab === 'home' ? (
              <motion.div 
                key="home"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-4"
              >
                {/* Temp & Humidity Display - Compact Grid */}
                <div className="grid grid-cols-2 gap-4">
                  {/* Temperature Section */}
                  <div className="relative flex flex-col items-center p-4 bg-zinc-900/30 border border-zinc-800/50 rounded-[2rem] overflow-hidden">
                    {/* Dynamic Background Glow */}
                    <motion.div 
                      animate={{
                        scale: [1, 1.2, 1],
                        opacity: [0.05, 0.1, 0.05],
                      }}
                      transition={{
                        duration: 4,
                        repeat: Infinity,
                        ease: "easeInOut"
                      }}
                      className={cn(
                        "absolute inset-0 blur-[60px] rounded-full transition-colors duration-1000",
                        status === 'HIGH' ? "bg-red-500" : status === 'LOW' ? "bg-blue-500" : "bg-emerald-500"
                      )}
                    />
                    
                    <div className="relative flex flex-col items-center">
                      {/* Trend Indicator */}
                      <AnimatePresence mode="wait">
                        {temp !== null && prevTemp !== null && temp !== prevTemp && (
                          <motion.div
                            initial={{ opacity: 0, y: 5 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -5 }}
                            className="absolute -top-6 flex items-center space-x-1"
                          >
                            {temp > prevTemp ? (
                              <TrendingUp className="w-3 h-3 text-red-400" />
                            ) : (
                              <TrendingDown className="w-3 h-3 text-blue-400" />
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <motion.div 
                        key={temp}
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="text-5xl font-light tracking-tighter leading-none flex items-start"
                      >
                        {temp !== null ? Math.round(temp) : '--'}
                        <span className="text-lg font-medium text-zinc-600 mt-1 ml-1">°C</span>
                      </motion.div>
                    </div>

                    <div className={cn(
                      "mt-3 px-3 py-1 rounded-full flex items-center space-x-1 border border-white/5 transition-colors duration-500",
                      getStatusBg(status)
                    )}>
                      <Activity className={cn("w-3 h-3", getStatusColor(status))} />
                      <span className={cn("text-[8px] font-bold tracking-widest uppercase", getStatusColor(status))}>
                        {status}
                      </span>
                    </div>

                    {/* Range Indicator */}
                    <div className="mt-3 flex space-x-3">
                      <div className="flex flex-col items-center">
                        <div className="text-blue-400 text-[9px] font-bold">
                          {settings.lowTempThreshold.toFixed(1)}°
                        </div>
                      </div>
                      <div className="flex flex-col items-center">
                        <div className="text-red-400 text-[9px] font-bold">
                          {settings.highTempThreshold.toFixed(1)}°
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Humidity Section */}
                  <div className="relative flex flex-col items-center p-4 bg-zinc-900/30 border border-zinc-800/50 rounded-[2rem] overflow-hidden">
                    {/* Dynamic Background Glow */}
                    <motion.div 
                      animate={{
                        scale: [1, 1.2, 1],
                        opacity: [0.05, 0.1, 0.05],
                      }}
                      transition={{
                        duration: 4,
                        repeat: Infinity,
                        ease: "easeInOut"
                      }}
                      className={cn(
                        "absolute inset-0 blur-[60px] rounded-full transition-colors duration-1000",
                        humidityStatus === 'HIGH' ? "bg-amber-500" : humidityStatus === 'LOW' ? "bg-cyan-500" : "bg-emerald-500"
                      )}
                    />
                    
                    <div className="relative flex flex-col items-center">
                      {/* Trend Indicator */}
                      <AnimatePresence mode="wait">
                        {humidity !== null && prevHumidity !== null && humidity !== prevHumidity && (
                          <motion.div
                            initial={{ opacity: 0, y: 5 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -5 }}
                            className="absolute -top-6 flex items-center space-x-1"
                          >
                            {humidity > prevHumidity ? (
                              <TrendingUp className="w-3 h-3 text-amber-400" />
                            ) : (
                              <TrendingDown className="w-3 h-3 text-cyan-400" />
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <motion.div 
                        key={humidity}
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="text-5xl font-light tracking-tighter leading-none flex items-start"
                      >
                        {humidity !== null ? Math.round(humidity) : '--'}
                        <span className="text-lg font-medium text-zinc-600 mt-1 ml-1">%</span>
                      </motion.div>
                    </div>

                    <div className={cn(
                      "mt-3 px-3 py-1 rounded-full flex items-center space-x-1 border border-white/5 transition-colors duration-500",
                      getStatusBg(humidityStatus)
                    )}>
                      <Droplets className={cn("w-3 h-3", getStatusColor(humidityStatus))} />
                      <span className={cn("text-[8px] font-bold tracking-widest uppercase", getStatusColor(humidityStatus))}>
                        {humidityStatus}
                      </span>
                    </div>

                    {/* Threshold Indicators */}
                    <div className="mt-3 flex space-x-3">
                      <div className="flex flex-col items-center">
                        <div className="text-cyan-400 text-[9px] font-bold">
                          {settings.lowHumidityThreshold}%
                        </div>
                      </div>
                      <div className="flex flex-col items-center">
                        <div className="text-amber-400 text-[9px] font-bold">
                          {settings.highHumidityThreshold}%
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Quick Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-zinc-900/50 border border-zinc-800 p-4 rounded-2xl">
                    <div className="flex items-center space-x-2 mb-1 text-zinc-500">
                      <Thermometer className="w-3 h-3" />
                      <span className="text-[8px] font-bold uppercase tracking-wider">Precise Temp</span>
                    </div>
                    <p className="text-xl font-mono">{temp !== null ? temp.toFixed(2) : '--'}<span className="text-[10px] ml-1 text-zinc-500">°C</span></p>
                  </div>
                  <div className="bg-zinc-900/50 border border-zinc-800 p-4 rounded-2xl">
                    <div className="flex items-center space-x-2 mb-1 text-zinc-500">
                      <Droplets className="w-3 h-3" />
                      <span className="text-[8px] font-bold uppercase tracking-wider">Precise Hum</span>
                    </div>
                    <p className="text-xl font-mono">{humidity !== null ? humidity.toFixed(2) : '--'}<span className="text-[10px] ml-1 text-zinc-500">%</span></p>
                  </div>
                </div>

                <div className="bg-zinc-900/30 border border-zinc-800/50 p-2 rounded-2xl h-24 overflow-hidden relative">
                  {history.length > 1 ? (
                    <div className="absolute inset-0 w-full h-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={history.slice(-30)} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                          <defs>
                            <linearGradient id="miniTemp" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                              <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <Area 
                            type="monotone" 
                            dataKey="temp" 
                            stroke="#10b981" 
                            fill="url(#miniTemp)" 
                            strokeWidth={1.5} 
                            dot={false}
                            isAnimationActive={false}
                          />
                          <Area 
                            type="monotone" 
                            dataKey="humidity" 
                            stroke="#3b82f6" 
                            fill="transparent" 
                            strokeWidth={1} 
                            strokeDasharray="3 3"
                            dot={false}
                            isAnimationActive={false}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <p className="text-[8px] text-zinc-600 font-bold uppercase tracking-widest">Collecting Data...</p>
                    </div>
                  )}
                </div>

                {/* Relay Controls */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-1">
                    <div className="flex items-center space-x-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                      <h3 className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">System Control</h3>
                    </div>
                    <div className="flex bg-zinc-900/80 border border-zinc-800 rounded-lg p-0.5">
                      <button 
                        onClick={() => setMode('AUTO')}
                        className={cn(
                          "px-3 py-1 text-[8px] font-bold rounded-md transition-all",
                          controlMode === 'AUTO' ? "bg-emerald-500 text-emerald-950 shadow-lg" : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        AUTO
                      </button>
                      <button 
                        onClick={() => setMode('MANUAL')}
                        className={cn(
                          "px-3 py-1 text-[8px] font-bold rounded-md transition-all",
                          controlMode === 'MANUAL' ? "bg-amber-500 text-amber-950 shadow-lg" : "text-zinc-500 hover:text-zinc-300"
                        )}
                      >
                        MANUAL
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Heater Control */}
                    <div className={cn(
                      "bg-zinc-900/50 border p-3 rounded-2xl backdrop-blur-md flex flex-col items-center space-y-2 transition-all duration-500",
                      controlMode === 'MANUAL' ? "border-zinc-700 opacity-100" : "border-zinc-800 opacity-40"
                    )}>
                      <div className="flex items-center space-x-2 w-full">
                        <div className={cn(
                          "p-1.5 rounded-lg transition-colors duration-500",
                          relayState === 'ON' ? "bg-emerald-500/20" : "bg-zinc-800"
                        )}>
                          <Activity className={cn("w-4 h-4", relayState === "ON" ? "text-emerald-500" : "text-zinc-600")} />
                        </div>
                        <span className="text-[10px] font-bold text-zinc-200 uppercase tracking-tight">Heater</span>
                      </div>
                      <button 
                        onClick={toggleRelay}
                        disabled={!isConnected || controlMode === 'AUTO'}
                        className={cn(
                          "w-full h-8 rounded-xl relative transition-all duration-500 disabled:opacity-30 flex items-center px-1",
                          relayState === "ON" ? "bg-emerald-500" : "bg-zinc-800",
                          controlMode === 'AUTO' && "cursor-not-allowed"
                        )}
                      >
                        <motion.div 
                          animate={{ x: relayState === "ON" ? 22 : 0 }}
                          className="w-6 h-6 bg-white rounded-lg shadow-lg" 
                        />
                        <span className={cn(
                          "absolute right-3 text-[8px] font-bold uppercase",
                          relayState === "ON" ? "text-emerald-950" : "text-zinc-500"
                        )}>
                          {relayState}
                        </span>
                      </button>
                    </div>

                    {/* Humidifier Control */}
                    <div className={cn(
                      "bg-zinc-900/50 border p-3 rounded-2xl backdrop-blur-md flex flex-col items-center space-y-2 transition-all duration-500",
                      controlMode === 'MANUAL' ? "border-zinc-700 opacity-100" : "border-zinc-800 opacity-40"
                    )}>
                      <div className="flex items-center space-x-2 w-full">
                        <div className={cn(
                          "p-1.5 rounded-lg transition-colors duration-500",
                          humidifierState === 'ON' ? "bg-cyan-500/20" : "bg-zinc-800"
                        )}>
                          <Droplets className={cn("w-4 h-4", humidifierState === "ON" ? "text-cyan-500" : "text-zinc-600")} />
                        </div>
                        <span className="text-[10px] font-bold text-zinc-200 uppercase tracking-tight">Humidifier</span>
                      </div>
                      <button 
                        onClick={toggleHumidifier}
                        disabled={!isConnected || controlMode === 'AUTO'}
                        className={cn(
                          "w-full h-8 rounded-xl relative transition-all duration-500 disabled:opacity-30 flex items-center px-1",
                          humidifierState === "ON" ? "bg-cyan-500" : "bg-zinc-800",
                          controlMode === 'AUTO' && "cursor-not-allowed"
                        )}
                      >
                        <motion.div 
                          animate={{ x: humidifierState === "ON" ? 22 : 0 }}
                          className="w-6 h-6 bg-white rounded-lg shadow-lg" 
                        />
                        <span className={cn(
                          "absolute right-3 text-[8px] font-bold uppercase",
                          humidifierState === "ON" ? "text-cyan-950" : "text-zinc-500"
                        )}>
                          {humidifierState}
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Fan Control */}
                  <div className={cn(
                    "bg-zinc-900/50 border border-zinc-800 p-4 rounded-3xl backdrop-blur-md space-y-4 transition-all duration-500",
                    controlMode === 'MANUAL' ? "opacity-100" : "opacity-40"
                  )}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className={cn(
                          "p-2 rounded-xl transition-colors duration-500",
                          fanState === 'ON' ? "bg-blue-500/20" : "bg-zinc-800"
                        )}>
                          <RefreshCw className={cn("w-5 h-5", fanState === "ON" ? "text-blue-500 animate-spin" : "text-zinc-600")} style={{ animationDuration: fanState === 'ON' ? `${Math.max(0.5, 2 - (fanSpeed / 50))}s` : '0s' }} />
                        </div>
                        <div>
                          <span className="text-xs font-bold text-zinc-200 uppercase tracking-tight block">Fan System</span>
                          <span className="text-[8px] text-zinc-500 font-bold uppercase tracking-widest">{fanState === 'ON' ? `Running at ${fanSpeed}%` : 'Stopped'}</span>
                        </div>
                      </div>
                      <button 
                        onClick={toggleFan}
                        disabled={!isConnected || controlMode === 'AUTO'}
                        className={cn(
                          "w-12 h-6 rounded-full relative transition-all duration-500 disabled:opacity-30",
                          fanState === "ON" ? "bg-blue-500" : "bg-zinc-800",
                          controlMode === 'AUTO' && "cursor-not-allowed"
                        )}
                      >
                        <motion.div 
                          animate={{ x: fanState === "ON" ? 24 : 4 }}
                          className="absolute top-1 w-4 h-4 bg-white rounded-full shadow-lg" 
                        />
                      </button>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-[8px] font-bold uppercase tracking-widest text-zinc-500">
                        <span>Fan Speed</span>
                        <span className="text-blue-400">{fanSpeed}%</span>
                      </div>
                      <input 
                        type="range" 
                        min="0" 
                        max="100" 
                        step="1" 
                        value={fanSpeed}
                        disabled={!isConnected || controlMode === 'AUTO' || fanState === 'OFF'}
                        onChange={(e) => updateFanSpeed(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-30 disabled:cursor-not-allowed"
                      />
                    </div>
                  </div>
                </div>

                {/* Environmental Threshold Controls */}
                <div className="space-y-4">
                  <div className="flex items-center space-x-2 px-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
                    <h3 className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">Environmental Thresholds</h3>
                  </div>

                  {/* Temperature Thresholds Card */}
                  <div className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-3xl backdrop-blur-md space-y-5">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center space-x-3">
                        <div className="p-2 bg-red-500/10 rounded-xl">
                          <Thermometer className="w-5 h-5 text-red-500" />
                        </div>
                        <span className="text-xs font-bold text-zinc-200 uppercase tracking-tight block">Temperature Range</span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-mono font-bold text-red-500">
                          {settings.lowTempThreshold.toFixed(1)}° - {settings.highTempThreshold.toFixed(1)}°C
                        </p>
                        <p className="text-[8px] text-zinc-500 font-bold uppercase tracking-widest">
                          Sync: {remoteLowTemp?.toFixed(1) || '--'}/{remoteHighTemp?.toFixed(1) || '--'}
                        </p>
                      </div>
                    </div>
                    
                    <div className="space-y-6">
                      {/* Low Temp Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[8px] font-bold uppercase tracking-widest text-zinc-500">
                          <span>Low Limit (Heater ON)</span>
                          <span className="text-blue-400">{settings.lowTempThreshold.toFixed(1)}°C</span>
                        </div>
                        <input 
                          type="range" 
                          min="0" 
                          max="100" 
                          step="0.1" 
                          value={settings.lowTempThreshold}
                          onChange={(e) => updateTempThresholds(parseFloat(e.target.value), settings.highTempThreshold)}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                        />
                      </div>

                      {/* High Temp Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[8px] font-bold uppercase tracking-widest text-zinc-500">
                          <span>High Limit (Heater OFF)</span>
                          <span className="text-red-400">{settings.highTempThreshold.toFixed(1)}°C</span>
                        </div>
                        <input 
                          type="range" 
                          min="0" 
                          max="100" 
                          step="0.1" 
                          value={settings.highTempThreshold}
                          onChange={(e) => updateTempThresholds(settings.lowTempThreshold, parseFloat(e.target.value))}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-red-500"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Humidity Thresholds Card */}
                  <div className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-3xl backdrop-blur-md space-y-5">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center space-x-3">
                        <div className="p-2 bg-cyan-500/10 rounded-xl">
                          <Droplets className="w-5 h-5 text-cyan-500" />
                        </div>
                        <span className="text-xs font-bold text-zinc-200 uppercase tracking-tight block">Humidity Range</span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-mono font-bold text-cyan-500">
                          {settings.lowHumidityThreshold.toFixed(1)}% - {settings.highHumidityThreshold.toFixed(1)}%
                        </p>
                        <p className="text-[8px] text-zinc-500 font-bold uppercase tracking-widest">
                          Sync: {remoteLowHumidity?.toFixed(1) || '--'}/{remoteHighHumidity?.toFixed(1) || '--'}
                        </p>
                      </div>
                    </div>
                    
                    <div className="space-y-6">
                      {/* Low Humidity Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[8px] font-bold uppercase tracking-widest text-zinc-500">
                          <span>Low Limit (Humidifier ON)</span>
                          <span className="text-cyan-400">{settings.lowHumidityThreshold.toFixed(1)}%</span>
                        </div>
                        <input 
                          type="range" 
                          min="0" 
                          max="100" 
                          step="1" 
                          value={settings.lowHumidityThreshold}
                          onChange={(e) => updateHumidityThresholds(parseFloat(e.target.value), settings.highHumidityThreshold)}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                        />
                      </div>

                      {/* High Humidity Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[8px] font-bold uppercase tracking-widest text-zinc-500">
                          <span>High Limit (Humidifier OFF)</span>
                          <span className="text-amber-400">{settings.highHumidityThreshold.toFixed(1)}%</span>
                        </div>
                        <input 
                          type="range" 
                          min="0" 
                          max="100" 
                          step="1" 
                          value={settings.highHumidityThreshold}
                          onChange={(e) => updateHumidityThresholds(settings.lowHumidityThreshold, parseFloat(e.target.value))}
                          className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Alarm Banner */}
                {isAlarmActive && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="bg-red-500 text-white p-4 rounded-2xl flex items-center justify-between shadow-[0_0_30px_rgba(239,68,68,0.3)]"
                  >
                    <div className="flex items-center space-x-3">
                      <AlertCircle className="w-6 h-6 animate-bounce" />
                      <div>
                        <p className="font-bold text-sm">CRITICAL ALERT</p>
                        <p className="text-[10px] opacity-80">
                          {status !== 'NORMAL' ? `Temp: ${status}` : ''} 
                          {status !== 'NORMAL' && humidityStatus !== 'NORMAL' ? ' | ' : ''}
                          {humidityStatus !== 'NORMAL' ? `Humidity: ${humidityStatus}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      {!isAudioUnlocked && (
                        <button 
                          onClick={unlockAudio}
                          className="bg-emerald-500 text-emerald-950 px-3 py-2 rounded-xl text-[10px] font-black animate-pulse shadow-lg"
                        >
                          ENABLE SOUND
                        </button>
                      )}
                      <button 
                        onClick={stopAlarm}
                        className="bg-white/20 hover:bg-white/30 px-4 py-2 rounded-xl text-xs font-bold transition-colors"
                      >
                        MUTE
                      </button>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            ) : activeTab === 'history' ? (
              <motion.div 
                key="history"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-bold">Environmental History</h2>
                  <button 
                    onClick={clearHistory}
                    className="p-2 text-zinc-500 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>

                <div className="bg-zinc-900/50 border border-zinc-800 p-3 rounded-2xl h-56 flex items-center justify-center overflow-hidden relative">
                  {history.length > 1 ? (
                    <div className="absolute inset-0 w-full h-full p-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={history} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} opacity={0.3} />
                          <XAxis 
                            dataKey="time" 
                            stroke="#71717a" 
                            fontSize={10} 
                            tickLine={false} 
                            axisLine={false}
                            interval="preserveStartEnd"
                            minTickGap={30}
                          />
                          <YAxis 
                            stroke="#71717a" 
                            fontSize={10} 
                            tickLine={false} 
                            axisLine={false}
                            domain={['auto', 'auto']}
                            allowDecimals={true}
                          />
                          <Tooltip 
                            contentStyle={{ 
                              backgroundColor: '#18181b', 
                              border: '1px solid #27272a', 
                              borderRadius: '12px', 
                              fontSize: '12px' 
                            }}
                            itemStyle={{ fontSize: '10px' }}
                          />
                          <Line 
                            type="monotone" 
                            dataKey="temp" 
                            name="Temp"
                            stroke="#10b981" 
                            strokeWidth={2}
                            dot={false}
                            animationDuration={300}
                          />
                          <Line 
                            type="monotone" 
                            dataKey="humidity" 
                            name="Humidity"
                            stroke="#3b82f6" 
                            strokeWidth={2}
                            strokeDasharray="5 5"
                            dot={false}
                            animationDuration={300}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center text-zinc-600 space-y-2">
                      <TrendingUp className="w-8 h-8 opacity-20" />
                      <p className="text-xs font-medium">Waiting for data...</p>
                      <p className="text-[10px] opacity-50">Need at least 2 readings</p>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-[8px] font-bold text-zinc-500 uppercase tracking-widest px-2">Recent Readings</p>
                  <div className="space-y-1 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                    {history.slice().reverse().map((point) => (
                      <div key={point.id} className="flex items-center justify-between bg-zinc-900/30 p-2 rounded-xl border border-zinc-800/50">
                        <span className="text-[10px] text-zinc-500">{point.time}</span>
                        <div className="flex space-x-3">
                          <span className="font-mono font-bold text-emerald-500 text-xs">{point.temp.toFixed(1)}°</span>
                          <span className="font-mono font-bold text-blue-500 text-xs">{point.humidity.toFixed(1)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-8"
              >
                <div className="space-y-3">
                  {/* Toggles Grid */}
                  <div className="grid grid-cols-2 gap-3">
                    {/* Alarm Toggle */}
                    <div className="flex flex-col items-center justify-center bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 space-y-3">
                      <div className={cn("p-2 rounded-xl", settings.alarmEnabled ? "bg-emerald-500/10" : "bg-zinc-800")}>
                        {settings.alarmEnabled ? <Bell className="w-5 h-5 text-emerald-500" /> : <BellOff className="w-5 h-5 text-zinc-500" />}
                      </div>
                      <span className="text-[10px] font-bold uppercase tracking-wider">Alarm</span>
                      <button 
                        onClick={() => setSettings(s => ({ ...s, alarmEnabled: !s.alarmEnabled }))}
                        className={cn(
                          "w-10 h-6 rounded-full relative transition-colors duration-300",
                          settings.alarmEnabled ? "bg-emerald-500" : "bg-zinc-700"
                        )}
                      >
                        <div className={cn(
                          "absolute top-1 w-4 h-4 bg-white rounded-full transition-all duration-300 shadow-sm",
                          settings.alarmEnabled ? "left-5" : "left-1"
                        )} />
                      </button>
                    </div>

                    {/* Vibrate Toggle */}
                    <div className="flex flex-col items-center justify-center bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 space-y-3">
                      <div className={cn("p-2 rounded-xl", settings.vibrateEnabled ? "bg-emerald-500/10" : "bg-zinc-800")}>
                        <Activity className={cn("w-5 h-5", settings.vibrateEnabled ? "text-emerald-500" : "text-zinc-500")} />
                      </div>
                      <span className="text-[10px] font-bold uppercase tracking-wider">Vibrate</span>
                      <button 
                        onClick={() => setSettings(s => ({ ...s, vibrateEnabled: !s.vibrateEnabled }))}
                        className={cn(
                          "w-10 h-6 rounded-full relative transition-colors duration-300",
                          settings.vibrateEnabled ? "bg-emerald-500" : "bg-zinc-700"
                        )}
                      >
                        <div className={cn(
                          "absolute top-1 w-4 h-4 bg-white rounded-full transition-all duration-300 shadow-sm",
                          settings.vibrateEnabled ? "left-5" : "left-1"
                        )} />
                      </button>
                    </div>
                  </div>

                  {/* Thresholds Grid */}
                  <div className="grid grid-cols-1 gap-3">
                    {/* Temperature Thresholds */}
                    <div className="bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 space-y-3">
                      <div className="flex items-center space-x-2">
                        <Thermometer className="w-4 h-4 text-zinc-400" />
                        <p className="text-[10px] font-bold uppercase tracking-wider">Temperature Alarm Range</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[8px] text-zinc-500 font-bold uppercase ml-1">Low (°C)</span>
                          <input 
                            type="number" 
                            step="0.1"
                            value={settings.lowTempThreshold}
                            onChange={(e) => updateTempThresholds(parseFloat(e.target.value) || 0, settings.highTempThreshold)}
                            className="w-full bg-zinc-800 border-none rounded-lg px-2 py-2 text-[10px] focus:ring-1 focus:ring-blue-500 outline-none"
                            placeholder="Low"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[8px] text-zinc-500 font-bold uppercase ml-1">High (°C)</span>
                          <input 
                            type="number" 
                            step="0.1"
                            value={settings.highTempThreshold}
                            onChange={(e) => updateTempThresholds(settings.lowTempThreshold, parseFloat(e.target.value) || 0)}
                            className="w-full bg-zinc-800 border-none rounded-lg px-2 py-2 text-[10px] focus:ring-1 focus:ring-red-500 outline-none"
                            placeholder="High"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Humidity Thresholds */}
                    <div className="bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 space-y-3">
                      <div className="flex items-center space-x-2">
                        <Droplets className="w-4 h-4 text-zinc-400" />
                        <p className="text-[10px] font-bold uppercase tracking-wider">Humidity Alarm Range</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <span className="text-[8px] text-zinc-500 font-bold uppercase ml-1">Low (%)</span>
                          <input 
                            type="number" 
                            value={settings.lowHumidityThreshold}
                            onChange={(e) => updateHumidityThresholds(parseFloat(e.target.value) || 0, settings.highHumidityThreshold)}
                            className="w-full bg-zinc-800 border-none rounded-lg px-2 py-2 text-[10px] focus:ring-1 focus:ring-cyan-500 outline-none"
                            placeholder="Low"
                          />
                        </div>
                        <div className="space-y-1">
                          <span className="text-[8px] text-zinc-500 font-bold uppercase ml-1">High (%)</span>
                          <input 
                            type="number" 
                            value={settings.highHumidityThreshold}
                            onChange={(e) => updateHumidityThresholds(settings.lowHumidityThreshold, parseFloat(e.target.value) || 0)}
                            className="w-full bg-zinc-800 border-none rounded-lg px-2 py-2 text-[10px] focus:ring-1 focus:ring-amber-500 outline-none"
                            placeholder="High"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Duration & Sound Grid */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 space-y-3">
                      <div className="flex items-center space-x-2">
                        <Clock className="w-4 h-4 text-zinc-400" />
                        <p className="text-[10px] font-bold uppercase tracking-wider">Duration</p>
                      </div>
                      <div className="flex space-x-1">
                        <input 
                          type="number" 
                          value={settings.alarmDuration}
                          onChange={(e) => setSettings(s => ({ ...s, alarmDuration: parseInt(e.target.value) || 0 }))}
                          className="w-full bg-zinc-800 border-none rounded-lg px-2 py-2 text-[10px] focus:ring-1 focus:ring-emerald-500 outline-none"
                        />
                        <select 
                          value={settings.alarmDurationUnit}
                          onChange={(e) => setSettings(s => ({ ...s, alarmDurationUnit: e.target.value as any }))}
                          className="bg-zinc-800 border-none rounded-lg px-1 py-2 text-[8px] focus:ring-1 focus:ring-emerald-500 outline-none"
                        >
                          <option value="seconds">S</option>
                          <option value="minutes">M</option>
                        </select>
                      </div>
                    </div>

                    <div className="bg-zinc-900/50 p-4 rounded-2xl border border-zinc-800 flex flex-col justify-center space-y-2">
                      <button 
                        onClick={testAlarm}
                        className="w-full flex items-center justify-center space-x-1 bg-emerald-500 hover:bg-emerald-600 text-zinc-950 py-2 rounded-xl text-[10px] font-bold transition-colors"
                      >
                        <Volume2 className="w-3 h-3" />
                        <span>Test Alarm</span>
                      </button>
                      <label className="w-full flex items-center justify-center space-x-1 bg-zinc-800 hover:bg-zinc-700 transition-colors py-2 rounded-xl cursor-pointer border border-dashed border-zinc-700 text-[10px]">
                        <Play className="w-3 h-3" />
                        <span>Upload</span>
                        <input type="file" accept="audio/*" onChange={handleSoundUpload} className="hidden" />
                      </label>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Footer Navigation (Mobile Style) */}
        <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-zinc-950/80 backdrop-blur-xl border-t border-zinc-800 p-4 flex justify-around items-center z-30">
          <button 
            onClick={() => setActiveTab('home')}
            className={cn(
              "flex flex-col items-center space-y-1 transition-colors",
              activeTab === 'home' ? "text-emerald-500" : "text-zinc-500"
            )}
          >
            <Activity className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase">Monitor</span>
          </button>
          <button 
            onClick={() => setActiveTab('history')}
            className={cn(
              "flex flex-col items-center space-y-1 transition-colors",
              activeTab === 'history' ? "text-emerald-500" : "text-zinc-500"
            )}
          >
            <History className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase">History</span>
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            className={cn(
              "flex flex-col items-center space-y-1 transition-colors",
              activeTab === 'settings' ? "text-emerald-500" : "text-zinc-500"
            )}
          >
            <SettingsIcon className="w-6 h-6" />
            <span className="text-[10px] font-bold uppercase">Settings</span>
          </button>
        </nav>
      </div>
    </div>
  );
}
