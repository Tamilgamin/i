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
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  Tooltip, 
  CartesianGrid 
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
  const activeTabRef = useRef(activeTab);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

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
    localStorage.setItem('incubator_history', JSON.stringify(history.slice(-100)));
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

  // Debounce MQTT publishing
  const debouncedPublish = useCallback((topic: string, message: string, delay: number = 1500) => {
    if (debounceTimers.current[topic]) {
      clearTimeout(debounceTimers.current[topic]);
    }
    debounceTimers.current[topic] = setTimeout(() => {
      if (mqttClient.current?.connected) {
        mqttClient.current.publish(topic, message, { qos: 0, retain: false });
      }
    }, delay);
  }, []);

  // 🔔 Alarm Control
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    setIsSnoozed(true);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if (alarmTimerRef.current) clearTimeout(alarmTimerRef.current);
    if (vibrationIntervalRef.current) clearInterval(vibrationIntervalRef.current);
    if (Capacitor.isNativePlatform()) LocalNotifications.cancel({ notifications: [{ id: 1 }] });
  }, []);

  // 🚀 Foreground service & Notifications
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.requestPermissions();
      LocalNotifications.registerActionTypes({
        types: [{ id: 'ALARM_ACTIONS', actions: [{ id: 'mute', title: 'Mute Alarm', foreground: true }] }]
      });
      LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        if (action.actionId === 'mute') stopAlarm();
      });
    }
  }, [stopAlarm]);

  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  // MQTT Connection Logic
  useEffect(() => {
    const client = mqtt.connect(`wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`, {
      username: MQTT_CONFIG.username,
      password: MQTT_CONFIG.password,
      clientId: `incubator_${Math.random().toString(16).slice(2, 10)}`,
      clean: true,
      connectTimeout: 30000,
      reconnectPeriod: 5000,
    });

    mqttClient.current = client;

    client.on('connect', () => {
      setIsConnected(true);
      setIsReconnecting(false);
      setErrorMsg(null);
      client.subscribe([
        TOPICS.temp, TOPICS.humidity, TOPICS.relayState, TOPICS.humidifierState,
        TOPICS.tempHigh, TOPICS.tempLow, TOPICS.humidityHigh, TOPICS.humidityLow
      ]);
    });

    client.on('error', (err) => {
      if (err.message !== 'client disconnecting') setErrorMsg(err.message);
      setIsConnected(false);
    });

    client.on('close', () => setIsConnected(false));
    client.on('reconnect', () => setIsReconnecting(true));

    client.on('message', (topic, message) => {
      const payload = message.toString();
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const currentSettings = settingsRef.current;

      if (topic === TOPICS.temp) {
        const newTemp = parseFloat(payload);
        if (isNaN(newTemp) || newTemp < -50) return;
        setTemp(current => { setPrevTemp(current); return newTemp; });
        setHistory(prev => {
          const h = latestHumidityRef.current !== null ? latestHumidityRef.current : 0;
          const newPoint = { id: `${Date.now()}`, time: timeStr, temp: newTemp, humidity: h, timestamp: Date.now() };
          if (prev.length > 0 && Date.now() - prev[prev.length - 1].timestamp < 2000) {
            return [...prev.slice(0, -1), { ...prev[prev.length - 1], temp: newTemp, time: timeStr }];
          }
          return [...prev, newPoint].slice(-100);
        });
        if (newTemp < currentSettings.lowTempThreshold) setStatus('LOW');
        else if (newTemp > currentSettings.highTempThreshold) setStatus('HIGH');
        else setStatus('NORMAL');
      }

      if (topic === TOPICS.humidity) {
        const newHumidity = parseFloat(payload);
        if (isNaN(newHumidity)) return;
        setHumidity(current => { setPrevHumidity(current); return newHumidity; });
        setHistory(prev => {
          const t = latestTempRef.current !== null ? latestTempRef.current : 0;
          const newPoint = { id: `${Date.now()}`, time: timeStr, temp: t, humidity: newHumidity, timestamp: Date.now() };
          if (prev.length > 0 && Date.now() - prev[prev.length - 1].timestamp < 2000) {
            return [...prev.slice(0, -1), { ...prev[prev.length - 1], humidity: newHumidity, time: timeStr }];
          }
          return [...prev, newPoint].slice(-100);
        });
        if (newHumidity < currentSettings.lowHumidityThreshold) setHumidityStatus('LOW');
        else if (newHumidity > currentSettings.highHumidityThreshold) setHumidityStatus('HIGH');
        else setHumidityStatus('NORMAL');
      }

      if (topic === TOPICS.relayState) setRelayState(payload.toUpperCase() === 'ON' ? 'ON' : 'OFF');
      if (topic === TOPICS.humidifierState) setHumidifierState(payload.toUpperCase() === 'ON' ? 'ON' : 'OFF');
      
      // Remote threshold sync (only if not actively editing)
      if (activeTabRef.current !== 'settings') {
        if (topic === TOPICS.tempHigh) setSettings(s => ({ ...s, highTempThreshold: parseFloat(payload) }));
        if (topic === TOPICS.tempLow) setSettings(s => ({ ...s, lowTempThreshold: parseFloat(payload) }));
        if (topic === TOPICS.humidityHigh) setSettings(s => ({ ...s, highHumidityThreshold: parseFloat(payload) }));
        if (topic === TOPICS.humidityLow) setSettings(s => ({ ...s, lowHumidityThreshold: parseFloat(payload) }));
      }
    });

    return () => { client.end(true); };
  }, [reconnectTrigger]);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive || isSnoozed) return;
    setIsAlarmActive(true);
    if (audioRef.current) audioRef.current.play().catch(() => {});
    if (settings.vibrateEnabled && Capacitor.isNativePlatform()) Haptics.vibrate({ duration: 1000 });
    const alertBody = `Temp: ${temp}°C, Hum: ${humidity}%. Check incubator!`;
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.schedule({ notifications: [{ title: "🚨 Incubator Alert!", body: alertBody, id: 1, sound: 'alarm.wav', ongoing: true }] });
    }
    const durationMs = settings.alarmDurationUnit === 'minutes' ? settings.alarmDuration * 60 * 1000 : settings.alarmDuration * 1000;
    alarmTimerRef.current = setTimeout(stopAlarm, durationMs);
  }, [settings, isAlarmActive, isSnoozed, temp, humidity, stopAlarm]);

  useEffect(() => {
    if (temp !== null || humidity !== null) {
      const isOut = (temp !== null && (temp < settings.lowTempThreshold || temp > settings.highTempThreshold)) ||
                    (humidity !== null && (humidity < settings.lowHumidityThreshold || humidity > settings.highHumidityThreshold));
      if (isOut) triggerAlarm();
      else { if (isAlarmActive) stopAlarm(); setIsSnoozed(false); }
    }
  }, [temp, humidity, triggerAlarm, settings, isAlarmActive, stopAlarm]);

  const getStatusColor = (s: Status) => s === 'LOW' ? 'text-blue-500' : s === 'HIGH' ? 'text-red-500' : 'text-emerald-500';
  const getStatusBg = (s: Status) => s === 'LOW' ? 'bg-blue-500/10' : s === 'HIGH' ? 'bg-red-500/10' : 'bg-emerald-500/10';

  const updateTempThresholds = (low: number, high: number) => {
    setSettings(s => ({ ...s, lowTempThreshold: low, highTempThreshold: high }));
    if (low < high) {
      debouncedPublish(TOPICS.tempLowSet, low.toFixed(1));
      debouncedPublish(TOPICS.tempHighSet, high.toFixed(1));
    }
  };

  const updateHumidityThresholds = (low: number, high: number) => {
    setSettings(s => ({ ...s, lowHumidityThreshold: low, highHumidityThreshold: high }));
    if (low < high) {
      debouncedPublish(TOPICS.humidityLowSet, low.toFixed(0));
      debouncedPublish(TOPICS.humidityHighSet, high.toFixed(0));
    }
  };

  const toggleRelay = () => mqttClient.current?.publish(TOPICS.relayControl, relayState === "ON" ? "OFF" : "ON");
  const toggleHumidifier = () => mqttClient.current?.publish(TOPICS.humidifierControl, humidifierState === "ON" ? "OFF" : "ON");
  const setMode = (mode: 'AUTO' | 'MANUAL') => { setControlMode(mode); mqttClient.current?.publish('incubator/mode/set', mode); };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      <audio ref={audioRef} src={settings.customSoundUrl || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3'} loop />
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative">
        <header className="p-4 flex justify-between items-center border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center space-x-3">
            <div className={cn("p-2 rounded-xl", isConnected ? "bg-emerald-500/10" : "bg-red-500/10")}>
              {isConnected ? <Wifi className="w-5 h-5 text-emerald-500" /> : <WifiOff className="w-5 h-5 text-red-500" />}
            </div>
            <div>
              <h1 className="text-base font-bold">Incubator</h1>
              <p className={cn("text-[8px] font-mono uppercase tracking-widest", isConnected ? "text-emerald-500" : "text-red-500")}>
                {isConnected ? 'Connected' : errorMsg || 'Disconnected'}
              </p>
            </div>
          </div>
          <button onClick={() => setActiveTab(activeTab === 'home' ? 'settings' : 'home')} className="p-2 rounded-xl hover:bg-zinc-800"><SettingsIcon className="w-5 h-5" /></button>
        </header>

        <main className="flex-1 p-4 overflow-y-auto pb-24">
          <AnimatePresence mode="wait">
            {activeTab === 'home' ? (
              <motion.div key="home" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-zinc-900/30 border border-zinc-800/50 rounded-[2rem] flex flex-col items-center">
                    <div className="text-5xl font-light">{temp !== null ? Math.round(temp) : '--'}<span className="text-lg text-zinc-600">°C</span></div>
                    <div className={cn("mt-2 px-3 py-1 rounded-full text-[8px] font-bold", getStatusBg(status), getStatusColor(status))}>{status}</div>
                  </div>
                  <div className="p-4 bg-zinc-900/30 border border-zinc-800/50 rounded-[2rem] flex flex-col items-center">
                    <div className="text-5xl font-light">{humidity !== null ? Math.round(humidity) : '--'}<span className="text-lg text-zinc-600">%</span></div>
                    <div className={cn("mt-2 px-3 py-1 rounded-full text-[8px] font-bold", getStatusBg(humidityStatus), getStatusColor(humidityStatus))}>{humidityStatus}</div>
                  </div>
                </div>

                {/* Real-time Graph */}
                <div className="bg-zinc-900/30 border border-zinc-800/50 p-4 rounded-3xl h-48 relative overflow-hidden">
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center space-x-2"><TrendingUp className="w-3 h-3 text-emerald-500" /><span className="text-[9px] font-bold text-zinc-500 uppercase">Real-time Trend</span></div>
                    <div className="flex items-center space-x-1"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /><span className="text-[8px] font-bold text-emerald-500 uppercase">Live</span></div>
                  </div>
                  {history.length > 1 ? (
                    <div className="absolute inset-x-0 bottom-0 h-32">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={history.slice(-30)}>
                          <defs><linearGradient id="miniTemp" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/><stop offset="95%" stopColor="#10b981" stopOpacity={0}/></linearGradient></defs>
                          <Area type="monotone" dataKey="temp" stroke="#10b981" fill="url(#miniTemp)" strokeWidth={2} dot={false} isAnimationActive={false} />
                          <Area type="monotone" dataKey="humidity" stroke="#3b82f6" fill="transparent" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <div className="h-full flex items-center justify-center text-[8px] text-zinc-600 uppercase">Collecting Data...</div>}
                </div>

                {/* Controls */}
                <div className="grid grid-c
