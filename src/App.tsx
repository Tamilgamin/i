/**
 * Incubator Monitor — FULL FEATURE VERSION
 * UI + MQTT + Relay + Alarm + Capacitor Notifications + Background Safe
 */

import { useState, useEffect, useRef, useCallback, ChangeEvent } from "react";
import mqtt from "mqtt";
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
  Activity,
  CheckCircle2
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// MQTT CONFIG
const MQTT_CONFIG = {
  host: "57f9938c484c4f0f9ad4b79b70ae3bf7.s1.eu.hivemq.cloud",
  port: 8884,
  username: "qqqqq",
  password: "Agash2008",
};

const TOPICS = {
  temp: "incubator/temp",
  relayState: "incubator/relaystate",
  relayControl: "incubator/relaycon",
};

type Status = "LOW" | "NORMAL" | "HIGH" | "DISCONNECTED";

interface AppSettings {
  alarmEnabled: boolean;
  alarmDuration: number;
  alarmDurationUnit: "seconds" | "minutes";
  customSoundUrl: string | null;
  lowTempThreshold: number;
  highTempThreshold: number;
}

// Native notification
async function notify(title: string, body: string) {
  if (!Capacitor.isNativePlatform()) return;
  await LocalNotifications.schedule({
    notifications: [{ title, body, id: Date.now() }],
  });
}

export default function App() {
  const [temp, setTemp] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("DISCONNECTED");
  const [relayState, setRelayState] = useState<"ON" | "OFF">("OFF");
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<"home" | "settings">("home");
  const [isAlarmActive, setIsAlarmActive] = useState(false);

  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('incubator_settings');
    const defaults: AppSettings = {
      alarmEnabled: true,
      alarmDuration: 30,
      alarmDurationUnit: "seconds",
      customSoundUrl: null,
      lowTempThreshold: 25,
      highTempThreshold: 38,
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

  const mqttClient = useRef<mqtt.MqttClient | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const alarmTimer = useRef<NodeJS.Timeout | null>(null);

  // Persistence
  useEffect(() => {
    const toSave = { ...settings, customSoundUrl: null };
    localStorage.setItem('incubator_settings', JSON.stringify(toSave));
  }, [settings]);

  // 🔔 Request notification permission
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      LocalNotifications.requestPermissions();
    }
  }, []);

  // 🚀 Foreground service (keeps app alive)
  useEffect(() => {
    if (Capacitor.getPlatform() === "android") {
      // @ts-ignore
      window.cordova?.plugins?.foregroundService?.start(
        "Incubator monitoring running"
      );
    }
  }, []);

  // 🔌 MQTT CONNECTION
  useEffect(() => {
    const client = mqtt.connect(
      `wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`,
      {
        username: MQTT_CONFIG.username,
        password: MQTT_CONFIG.password,
        reconnectPeriod: 5000,
        clientId: `incubator_${Math.random().toString(16).slice(2, 10)}`,
      }
    );

    mqttClient.current = client;

    client.on("connect", () => {
      setIsConnected(true);
      client.subscribe([TOPICS.temp, TOPICS.relayState]);
    });

    client.on("message", (topic, msg) => {
      const payload = msg.toString();

      if (topic === TOPICS.temp) {
        const value = parseFloat(payload);
        if (!isNaN(value)) {
          setTemp(value);

          if (value < settings.lowTempThreshold) setStatus("LOW");
          else if (value > settings.highTempThreshold) setStatus("HIGH");
          else setStatus("NORMAL");
        }
      }

      if (topic === TOPICS.relayState) {
        setRelayState(payload === "ON" ? "ON" : "OFF");
      }
    });

    client.on("close", () => {
      setIsConnected(false);
      setStatus("DISCONNECTED");
    });

    return () => client.end();
  }, [settings.lowTempThreshold, settings.highTempThreshold]);

  // 🔔 ALARM LOGIC
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (alarmTimer.current) clearTimeout(alarmTimer.current);
  }, []);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive) return;

    setIsAlarmActive(true);
    audioRef.current?.play().catch(() => {});

    await notify("🚨 Incubator Alert", `Temperature ${temp}°C (${status})`);

    const duration =
      settings.alarmDurationUnit === "minutes"
        ? settings.alarmDuration * 60000
        : settings.alarmDuration * 1000;

    alarmTimer.current = setTimeout(stopAlarm, duration);
  }, [settings, isAlarmActive, temp, status, stopAlarm]);

  useEffect(() => {
    if (temp === null) return;
    if (
      temp < settings.lowTempThreshold ||
      temp > settings.highTempThreshold
    ) {
      triggerAlarm();
    }
  }, [temp, triggerAlarm, settings.lowTempThreshold, settings.highTempThreshold]);

  // 🔌 RELAY TOGGLE
  const toggleRelay = () => {
    if (!mqttClient.current?.connected) return;
    const newState = relayState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.relayControl, newState);
  };

  // 🔊 SOUND UPLOAD
  const handleSoundUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSettings((s) => ({ ...s, customSoundUrl: URL.createObjectURL(file) }));
    }
  };

  const testAlarm = () => {
    if (audioRef.current) {
      audioRef.current.play().catch(e => console.error("Test playback failed", e));
      setTimeout(() => {
        audioRef.current?.pause();
        if (audioRef.current) audioRef.current.currentTime = 0;
      }, 3000);
    }
  };

  // UI Helpers
  const getStatusColor = (s: Status) => {
    switch (s) {
      case 'LOW': return 'text-sky-400';
      case 'NORMAL': return 'text-emerald-400';
      case 'HIGH': return 'text-rose-400';
      default: return 'text-zinc-500';
    }
  };

  const getStatusBg = (s: Status) => {
    switch (s) {
      case 'LOW': return 'bg-sky-500/5 border-sky-500/20';
      case 'NORMAL': return 'bg-emerald-500/5 border-emerald-500/20';
      case 'HIGH': return 'bg-rose-500/5 border-rose-500/20';
      default: return 'bg-zinc-500/5 border-zinc-500/20';
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <audio
        ref={audioRef}
        src={
          settings.customSoundUrl ||
          "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
        }
        loop
      />

      {/* Main Container */}
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative overflow-hidden">
        
        {/* Header */}
        <header className="p-6 flex justify-between items-center border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-xl sticky top-0 z-20">
          <div className="flex items-center space-x-4">
            <div className={cn(
              "p-2.5 rounded-2xl transition-all duration-500 border", 
              isConnected ? "bg-emerald-500/10 border-emerald-500/20" : "bg-rose-500/10 border-rose-500/20"
            )}>
              {isConnected ? (
                <Wifi className="w-5 h-5 text-emerald-400" />
              ) : (
                <WifiOff className="w-5 h-5 text-rose-400" />
              )}
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-zinc-100">Incubator_OS</h1>
              <p className={cn(
                "text-[9px] font-mono uppercase tracking-[0.2em] transition-colors duration-500", 
                isConnected ? "text-emerald-500" : "text-rose-500"
              )}>
                {isConnected ? 'SYS_ONLINE' : 'SYS_OFFLINE'}
              </p>
            </div>
          </div>
          
          <button 
            onClick={() => setActiveTab(activeTab === 'home' ? 'settings' : 'home')}
            className="p-2.5 rounded-2xl bg-zinc-900/50 border border-zinc-800/50 hover:bg-zinc-800 transition-all"
          >
            {activeTab === 'home' ? <SettingsIcon className="w-5 h-5 text-zinc-400" /> : <ChevronLeft className="w-5 h-5 text-zinc-400" />}
          </button>
        </header>

        {/* Content */}
        <main className="flex-1 p-6 overflow-y-auto pb-24">
          <AnimatePresence mode="wait">
            {activeTab === 'home' ? (
              <motion.div 
                key="home"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-8"
              >
                {/* Temp Display */}
                <div className="relative flex flex-col items-center py-16">
                  {/* Technical Background Grid */}
                  <div className="absolute inset-0 opacity-[0.03] pointer-events-none" 
                    style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '24px 24px' }} 
                  />
                  
                  {/* Dynamic Background Glow */}
                  <motion.div 
                    animate={{
                      scale: [1, 1.1, 1],
                      opacity: [0.03, 0.08, 0.03],
                    }}
                    transition={{
                      duration: 6,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                    className={cn(
                      "absolute inset-0 blur-[120px] rounded-full transition-colors duration-1000",
                      status === 'HIGH' ? "bg-rose-500" : status === 'LOW' ? "bg-sky-500" : "bg-emerald-500"
                    )}
                  />
                  
                  <div className="relative flex flex-col items-center">
                    {/* Radial Track Decoration */}
                    <div className="absolute -inset-12 border border-dashed border-zinc-800 rounded-full opacity-20 animate-[spin_60s_linear_infinite]" />
                    
                    <motion.div 
                      key={temp}
                      initial={{ scale: 0.98, opacity: 0, filter: 'blur(8px)' }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                      transition={{ type: 'spring', stiffness: 200, damping: 25 }}
                      className="text-[140px] font-mono font-light tracking-tighter leading-none flex items-start text-zinc-50"
                    >
                      {temp !== null ? Math.round(temp) : '--'}
                      <span className="text-3xl font-mono font-medium text-zinc-600 mt-6 ml-2">°C</span>
                    </motion.div>
                  </div>

                  <div className={cn(
                    "mt-12 px-8 py-2.5 rounded-full flex items-center space-x-3 border backdrop-blur-sm transition-all duration-500",
                    getStatusBg(status)
                  )}>
                    <motion.div
                      animate={status === 'NORMAL' ? {} : { scale: [1, 1.2, 1], opacity: [1, 0.7, 1] }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                    >
                      <Activity className={cn("w-4 h-4", getStatusColor(status))} />
                    </motion.div>
                    <span className={cn("text-xs font-mono font-bold tracking-[0.2em] uppercase", getStatusColor(status))}>
                      {status}
                    </span>
                  </div>

                  {/* Threshold Indicators */}
                  <div className="mt-10 flex justify-center space-x-16 text-[10px] font-mono font-bold tracking-widest text-zinc-600 uppercase">
                    <div className="flex flex-col items-center group">
                      <span className="mb-1.5 opacity-40 group-hover:opacity-100 transition-opacity">Limit_Min</span>
                      <span className="text-sky-400/60 font-mono">{settings.lowTempThreshold.toFixed(1)}°C</span>
                    </div>
                    <div className="flex flex-col items-center group">
                      <span className="mb-1.5 opacity-40 group-hover:opacity-100 transition-opacity">Limit_Max</span>
                      <span className="text-rose-400/60 font-mono">{settings.highTempThreshold.toFixed(1)}°C</span>
                    </div>
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-zinc-900/40 border border-zinc-800/50 p-6 rounded-[32px] backdrop-blur-sm hover:border-zinc-700/50 transition-colors">
                    <div className="flex items-center space-x-2 mb-4 text-zinc-500">
                      <Thermometer className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-mono font-bold uppercase tracking-[0.15em]">Precision_Val</span>
                    </div>
                    <p className="text-3xl font-mono tracking-tight text-zinc-200">
                      {temp !== null ? temp.toFixed(2) : '--'}
                      <span className="text-xs ml-1.5 text-zinc-600 font-sans">°C</span>
                    </p>
                  </div>
                  <div className="bg-zinc-900/40 border border-zinc-800/50 p-6 rounded-[32px] backdrop-blur-sm hover:border-zinc-700/50 transition-colors">
                    <div className="flex items-center space-x-2 mb-4 text-zinc-500">
                      <Bell className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-mono font-bold uppercase tracking-[0.15em]">Alert_Status</span>
                    </div>
                    <div className="flex items-center space-x-3">
                      <div className={cn(
                        "w-2.5 h-2.5 rounded-full transition-all duration-500", 
                        isAlarmActive ? "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.4)] animate-pulse" : "bg-zinc-800"
                      )} />
                      <p className="text-sm font-mono font-bold tracking-wider text-zinc-300">
                        {isAlarmActive ? 'TRIGGERED' : 'STANDBY'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Relay Control */}
                <div className="bg-zinc-900/40 border border-zinc-800/50 p-7 rounded-[32px] backdrop-blur-sm flex items-center justify-between hover:border-zinc-700/50 transition-colors">
                  <div className="flex items-center space-x-5">
                    <div className={cn(
                      "p-4 rounded-2xl transition-all duration-500 border",
                      relayState === 'ON' ? "bg-emerald-500/10 border-emerald-500/20" : "bg-zinc-800/50 border-zinc-700/30"
                    )}>
                      <Activity className={cn("w-6 h-6", relayState === "ON" ? "text-emerald-400" : "text-zinc-600")} />
                    </div>
                    <div>
                      <p className="font-bold text-zinc-200 tracking-tight">Relay_Control</p>
                      <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider mt-0.5">Manual_Override</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end space-y-3">
                    <button 
                      onClick={toggleRelay}
                      disabled={!isConnected}
                      className={cn(
                        "w-16 h-9 rounded-full relative transition-all duration-500 disabled:opacity-30 disabled:grayscale",
                        relayState === "ON" ? "bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.2)]" : "bg-zinc-800"
                      )}
                    >
                      <motion.div 
                        animate={{ x: relayState === "ON" ? 28 : 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                        className="absolute top-1.5 left-1.5 w-6 h-6 bg-white rounded-full shadow-lg" 
                      />
                    </button>
                    <span className={cn(
                      "text-[9px] font-mono font-bold uppercase tracking-[0.2em]",
                      relayState === "ON" ? "text-emerald-400" : "text-zinc-600"
                    )}>
                      State: {relayState}
                    </span>
                  </div>
                </div>

                {/* Alarm Banner */}
                {isAlarmActive && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="bg-rose-500 text-white p-5 rounded-[32px] flex items-center justify-between shadow-[0_0_30px_rgba(244,63,94,0.3)]"
                  >
                    <div className="flex items-center space-x-4">
                      <AlertCircle className="w-6 h-6 animate-bounce" />
                      <div>
                        <p className="font-bold text-sm uppercase tracking-tight">Critical_Alert</p>
                        <p className="text-[10px] font-mono opacity-80">Auto_Stop: {settings.alarmDuration}{settings.alarmDurationUnit === 'minutes' ? 'm' : 's'}</p>
                      </div>
                    </div>
                    <button 
                      onClick={stopAlarm}
                      className="bg-white/20 hover:bg-white/30 px-5 py-2.5 rounded-2xl text-[10px] font-mono font-bold transition-colors border border-white/10"
                    >
                      MUTE_SIGNAL
                    </button>
                  </motion.div>
                )}
              </motion.div>
            ) : (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-8"
              >
                <div className="space-y-6">
                  {/* Alarm Toggle */}
                  <div className="flex items-center justify-between bg-zinc-900/40 p-7 rounded-[32px] border border-zinc-800/50 backdrop-blur-sm">
                    <div className="flex items-center space-x-5">
                      <div className={cn(
                        "p-4 rounded-2xl border transition-all duration-500", 
                        settings.alarmEnabled ? "bg-emerald-500/10 border-emerald-500/20" : "bg-zinc-800/50 border-zinc-700/30"
                      )}>
                        {settings.alarmEnabled ? <Bell className="w-6 h-6 text-emerald-400" /> : <BellOff className="w-6 h-6 text-zinc-600" />}
                      </div>
                      <div>
                        <p className="font-bold text-zinc-200 tracking-tight">Master_Alarm</p>
                        <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider mt-0.5">Alert_System_State</p>
                      </div>
                    </div>
                    <button 
                      onClick={() => setSettings(s => ({ ...s, alarmEnabled: !s.alarmEnabled }))}
                      className={cn(
                        "w-16 h-9 rounded-full relative      LocalNotifications.requestPermissions();
    } else if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // 🚀 Foreground service (keeps app alive)
  useEffect(() => {
    if (Capacitor.getPlatform() === "android") {
      // @ts-ignore
      window.cordova?.plugins?.foregroundService?.start(
        "Incubator monitoring running"
      );
    }
  }, []);

  // 🔌 MQTT CONNECTION
  useEffect(() => {
    const client = mqtt.connect(
      `wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`,
      {
        username: MQTT_CONFIG.username,
        password: MQTT_CONFIG.password,
        reconnectPeriod: 5000,
        clientId: `incubator_${Math.random().toString(16).slice(2, 10)}`,
      }
    );

    mqttClient.current = client;

    client.on("connect", () => {
      setIsConnected(true);
      client.subscribe([TOPICS.temp, TOPICS.relayState]);
    });

    client.on("message", (topic, msg) => {
      const payload = msg.toString();

      if (topic === TOPICS.temp) {
        const value = parseFloat(payload);
        if (!isNaN(value)) {
          setTemp(value);

          if (value < settings.lowTempThreshold) setStatus("LOW");
          else if (value > settings.highTempThreshold) setStatus("HIGH");
          else setStatus("NORMAL");
        }
      }

      if (topic === TOPICS.relayState) {
        setRelayState(payload.toUpperCase() === "ON" ? "ON" : "OFF");
      }
    });

    client.on("close", () => {
      setIsConnected(false);
      setStatus("DISCONNECTED");
    });

    return () => client.end();
  }, [settings.lowTempThreshold, settings.highTempThreshold]);

  // 🔔 ALARM LOGIC
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (alarmTimer.current) clearTimeout(alarmTimer.current);
  }, []);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive) return;

    setIsAlarmActive(true);
    audioRef.current?.play().catch(() => {});

    await notify("🚨 Incubator Alert", `Temperature ${temp}°C (${status})`);

    const duration =
      settings.alarmDurationUnit === "minutes"
        ? settings.alarmDuration * 60000
        : settings.alarmDuration * 1000;

    alarmTimer.current = setTimeout(stopAlarm, duration);
  }, [settings, isAlarmActive, temp, status, stopAlarm]);

  useEffect(() => {
    if (temp === null) return;
    if (
      temp < settings.lowTempThreshold ||
      temp > settings.highTempThreshold
    ) {
      triggerAlarm();
    }
  }, [temp, triggerAlarm, settings.lowTempThreshold, settings.highTempThreshold]);

  // 🔌 RELAY TOGGLE
  const toggleRelay = () => {
    if (!mqttClient.current?.connected) return;
    const newState = relayState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.relayControl, newState);
  };

  // 🔊 SOUND UPLOAD
  const handleSoundUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSettings((s) => ({ ...s, customSoundUrl: URL.createObjectURL(file) }));
    }
  };

  const testAlarm = () => {
    if (audioRef.current) {
      audioRef.current.play().catch(e => console.error("Test playback failed", e));
      setTimeout(() => {
        audioRef.current?.pause();
        if (audioRef.current) audioRef.current.currentTime = 0;
      }, 3000);
    }
  };

  // UI Helpers
  const getStatusColor = (s: Status) => {
    switch (s) {
      case 'LOW': return 'text-sky-400';
      case 'NORMAL': return 'text-emerald-400';
      case 'HIGH': return 'text-rose-400';
      default: return 'text-zinc-500';
    }
  };

  const getStatusBg = (s: Status) => {
    switch (s) {
      case 'LOW': return 'bg-sky-500/5 border-sky-500/20';
      case 'NORMAL': return 'bg-emerald-500/5 border-emerald-500/20';
      case 'HIGH': return 'bg-rose-500/5 border-rose-500/20';
      default: return 'bg-zinc-500/5 border-zinc-500/20';
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <audio
        ref={audioRef}
        src={
          settings.customSoundUrl ||
          "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
        }
        loop
      />

      {/* Main Container */}
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative overflow-hidden">
        
        {/* Header */}
        <header className="p-6 flex justify-between items-center border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-xl sticky top-0 z-20">
          <div className="flex items-center space-x-4">
            <div className={cn(
              "p-2.5 rounded-2xl transition-all duration-500 border", 
              isConnected ? "bg-emerald-500/10 border-emerald-500/20" : "bg-rose-500/10 border-rose-500/20"
            )}>
              {isConnected ? (
                <Wifi className="w-5 h-5 text-emerald-400" />
              ) : (
                <WifiOff className="w-5 h-5 text-rose-400" />
              )}
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight text-zinc-100">Incubator_OS</h1>
              <p className={cn(
                "text-[9px] font-mono uppercase tracking-[0.2em] transition-colors duration-500", 
                isConnected ? "text-emerald-500" : "text-rose-500"
              )}>
                {isConnected ? 'SYS_ONLINE' : 'SYS_OFFLINE'}
              </p>
            </div>
          </div>
          
          <button 
            onClick={() => setActiveTab(activeTab === 'home' ? 'settings' : 'home')}
            className="p-2.5 rounded-2xl bg-zinc-900/50 border border-zinc-800/50 hover:bg-zinc-800 transition-all"
          >
            {activeTab === 'home' ? <SettingsIcon className="w-5 h-5 text-zinc-400" /> : <ChevronLeft className="w-5 h-5 text-zinc-400" />}
          </button>
        </header>

        {/* Content */}
        <main className="flex-1 p-6 overflow-y-auto pb-24">
          <AnimatePresence mode="wait">
            {activeTab === 'home' ? (
              <motion.div 
                key="home"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="space-y-8"
              >
                {/* Temp Display */}
                <div className="relative flex flex-col items-center py-16">
                  {/* Technical Background Grid */}
                  <div className="absolute inset-0 opacity-[0.03] pointer-events-none" 
                    style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '24px 24px' }} 
                  />
                  
                  {/* Dynamic Background Glow */}
                  <motion.div 
                    animate={{
                      scale: [1, 1.1, 1],
                      opacity: [0.03, 0.08, 0.03],
                    }}
                    transition={{
                      duration: 6,
                      repeat: Infinity,
                      ease: "easeInOut"
                    }}
                    className={cn(
                      "absolute inset-0 blur-[120px] rounded-full transition-colors duration-1000",
                      status === 'HIGH' ? "bg-rose-500" : status === 'LOW' ? "bg-sky-500" : "bg-emerald-500"
                    )}
                  />
                  
                  <div className="relative flex flex-col items-center">
                    {/* Radial Track Decoration */}
                    <div className="absolute -inset-12 border border-dashed border-zinc-800 rounded-full opacity-20 animate-[spin_60s_linear_infinite]" />
                    
                    <motion.div 
                      key={temp}
                      initial={{ scale: 0.98, opacity: 0, filter: 'blur(8px)' }}
                      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
                      transition={{ type: 'spring', stiffness: 200, damping: 25 }}
                      className="text-[140px] font-mono font-light tracking-tighter leading-none flex items-start text-zinc-50"
                    >
                      {temp !== null ? Math.round(temp) : '--'}
                      <span className="text-3xl font-mono font-medium text-zinc-600 mt-6 ml-2">°C</span>
                    </motion.div>
                  </div>

                  <div className={cn(
                    "mt-12 px-8 py-2.5 rounded-full flex items-center space-x-3 border backdrop-blur-sm transition-all duration-500",
                    getStatusBg(status)
                  )}>
                    <motion.div
                      animate={status === 'NORMAL' ? {} : { scale: [1, 1.2, 1], opacity: [1, 0.7, 1] }}
                      transition={{ repeat: Infinity, duration: 1.5 }}
                    >
                      <Activity className={cn("w-4 h-4", getStatusColor(status))} />
                    </motion.div>
                    <span className={cn("text-xs font-mono font-bold tracking-[0.2em] uppercase", getStatusColor(status))}>
                      {status}
                    </span>
                  </div>

                  {/* Threshold Indicators */}
                  <div className="mt-10 flex justify-center space-x-16 text-[10px] font-mono font-bold tracking-widest text-zinc-600 uppercase">
                    <div className="flex flex-col items-center group">
                      <span className="mb-1.5 opacity-40 group-hover:opacity-100 transition-opacity">Limit_Min</span>
                      <span className="text-sky-400/60 font-mono">{settings.lowTempThreshold.toFixed(1)}°C</span>
                    </div>
                    <div className="flex flex-col items-center group">
                      <span className="mb-1.5 opacity-40 group-hover:opacity-100 transition-opacity">Limit_Max</span>
                      <span className="text-rose-400/60 font-mono">{settings.highTempThreshold.toFixed(1)}°C</span>
                    </div>
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-zinc-900/40 border border-zinc-800/50 p-6 rounded-[32px] backdrop-blur-sm hover:border-zinc-700/50 transition-colors">
                    <div className="flex items-center space-x-2 mb-4 text-zinc-500">
                      <Thermometer className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-mono font-bold uppercase tracking-[0.15em]">Precision_Val</span>
                    </div>
                    <p className="text-3xl font-mono tracking-tight text-zinc-200">
                      {temp !== null ? temp.toFixed(2) : '--'}
                      <span className="text-xs ml-1.5 text-zinc-600 font-sans">°C</span>
                    </p>
                  </div>
                  <div className="bg-zinc-900/40 border border-zinc-800/50 p-6 rounded-[32px] backdrop-blur-sm hover:border-zinc-700/50 transition-colors">
                    <div className="flex items-center space-x-2 mb-4 text-zinc-500">
                      <Bell className="w-3.5 h-3.5" />
                      <span className="text-[9px] font-mono font-bold uppercase tracking-[0.15em]">Alert_Status</span>
                    </div>
                    <div className="flex items-center space-x-3">
                      <div className={cn(
                        "w-2.5 h-2.5 rounded-full transition-all duration-500", 
                        isAlarmActive ? "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.4)] animate-pulse" : "bg-zinc-800"
                      )} />
                      <p className="text-sm font-mono font-bold tracking-wider text-zinc-300">
                        {isAlarmActive ? 'TRIGGERED' : 'STANDBY'}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Relay Control */}
                <div className="bg-zinc-900/40 border border-zinc-800/50 p-7 rounded-[32px] backdrop-blur-sm flex items-center justify-between hover:border-zinc-700/50 transition-colors">
                  <div className="flex items-center space-x-5">
                    <div className={cn(
                      "p-4 rounded-2xl transition-all duration-500 border",
                      relayState === 'ON' ? "bg-emerald-500/10 border-emerald-500/20" : "bg-zinc-800/50 border-zinc-700/30"
                    )}>
                      <Activity className={cn("w-6 h-6", relayState === "ON" ? "text-emerald-400" : "text-zinc-600")} />
                    </div>
                    <div>
                      <p className="font-bold text-zinc-200 tracking-tight">Relay_Control</p>
                      <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider mt-0.5">Manual_Override</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end space-y-3">
                    <button 
                      onClick={toggleRelay}
                      disabled={!isConnected}
                      className={cn(
                        "w-16 h-9 rounded-full relative transition-all duration-500 disabled:opacity-30 disabled:grayscale",
                        relayState === "ON" ? "bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.2)]" : "bg-zinc-800"
                      )}
                    >
                      <motion.div 
                        animate={{ x: relayState === "ON" ? 28 : 0 }}
                        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                        className="absolute top-1.5 left-1.5 w-6 h-6 bg-white rounded-full shadow-lg" 
                      />
                    </button>
                    <span className={cn(
                      "text-[9px] font-mono font-bold uppercase tracking-[0.2em]",
                      relayState === "ON" ? "text-emerald-400" : "text-zinc-600"
                    )}>
                      State: {relayState}
                    </span>
                  </div>
                </div>

                {/* Alarm Banner */}
                {isAlarmActive && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="bg-rose-500 text-white p-5 rounded-[32px] flex items-center justify-between shadow-[0_0_30px_rgba(244,63,94,0.3)]"
                  >
                    <div className="flex items-center space-x-4">
                      <AlertCircle className="w-6 h-6 animate-bounce" />
                      <div>
                        <p className="font-bold text-sm uppercase tracking-tight">Critical_Alert</p>
                        <p className="text-[10px] font-mono opacity-80">Auto_Stop: {settings.alarmDuration}{settings.alarmDurationUnit === 'minutes' ? 'm' : 's'}</p>
                      </div>
                    </div>
                    <button 
                      onClick={stopAlarm}
                      className="bg-white/20 hover:bg-white/30 px-5 py-2.5 rounded-2xl text-[10px] font-mono font-bold transition-colors border border-white/10"
                    >
                      MUTE_SIGNAL
                    </button>
                  </motion.div>
                )}
              </motion.div>
            ) : (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-8"
              >
                <div className="space-y-6">
                  {/* Alarm Toggle */}
                  <div className="flex items-center justify-between bg-zinc-900/40 p-7 rounded-[32px] border border-zinc-800/50 backdrop-blur-sm">
                    <div className="flex items-center space-x-5">
                      <div className={cn(
                        "p-4 rounded-2xl border transition-all duration-500", 
                        settings.alarmEnabled ? "bg-emerald-500/10 border-emerald-500/20" : "bg-zinc-800/50 border-zinc-700/30"
                      )}>
                        {settings.alarmEnabled ? <Bell className="w-6 h-6 text-emerald-400" /> : <BellOff className="w-6 h-6 text-zinc-600" />}
                      </div>
                      <div>
                        <p className="font-bold text-zinc-200 tracking-tight">Master_Alarm</p>
                        <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider mt-0.5">Aler  useEffect(() => {
    const client = mqtt.connect(
      `wss://${MQTT_CONFIG.host}:${MQTT_CONFIG.port}/mqtt`,
      {
        username: MQTT_CONFIG.username,
        password: MQTT_CONFIG.password,
        reconnectPeriod: 5000,
      }
    );

    mqttClient.current = client;

    client.on("connect", () => {
      setIsConnected(true);
      client.subscribe([TOPICS.temp, TOPICS.relayState]);
    });

    client.on("message", (topic, message) => {
      const payload = message.toString();

      if (topic === TOPICS.temp) {
        const value = parseFloat(payload);
        if (!isNaN(value)) {
          setTemp(value);

          if (value < settings.lowTempThreshold) setStatus("LOW");
          else if (value > settings.highTempThreshold) setStatus("HIGH");
          else setStatus("NORMAL");
        }
      }

      if (topic === TOPICS.relayState) {
        setRelayState(payload === "ON" ? "ON" : "OFF");
      }
    });

    client.on("close", () => {
      setIsConnected(false);
      setStatus("DISCONNECTED");
    });

    return () => client.end();
  }, []);

  // Alarm logic
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (alarmTimerRef.current) clearTimeout(alarmTimerRef.current);
  }, []);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive) return;

    setIsAlarmActive(true);
    audioRef.current?.play().catch(() => {});

    await sendNativeNotification(
      "🚨 Incubator Alert",
      `Temperature ${temp}°C (${status})`
    );

    const duration =
      settings.alarmDurationUnit === "minutes"
        ? settings.alarmDuration * 60000
        : settings.alarmDuration * 1000;

    alarmTimerRef.current = setTimeout(stopAlarm, duration);
  }, [settings, isAlarmActive, temp, status, stopAlarm]);

  useEffect(() => {
    if (temp === null) return;
    if (
      temp < settings.lowTempThreshold ||
      temp > settings.highTempThreshold
    ) {
      triggerAlarm();
    }
  }, [temp]);

  // Relay toggle
  const toggleRelay = () => {
    if (!mqttClient.current?.connected) return;
    const newState = relayState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.relayControl, newState);
  };

  // Sound upload
  const handleSoundUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setSettings((s) => ({ ...s, customSoundUrl: url }));
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <audio
        ref={audioRef}
        src={
          settings.customSoundUrl ||
          "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
        }
        loop
      />

      {/* HEADER */}
      <header className="p-6 flex justify-between items-center border-b border-zinc-800">
        <div className="flex items-center space-x-3">
          {isConnected ? (
            <Wifi className="text-emerald-500" />
          ) : (
            <WifiOff className="text-red-500" />
          )}
          <div>
            <h1 className="font-bold">Incubator</h1>
            <p className="text-xs">{status}</p>
          </div>
        </div>
        <button onClick={() => setActiveTab(activeTab === "home" ? "settings" : "home")}>
          {activeTab === "home" ? <SettingsIcon /> : <ChevronLeft />}
        </button>
      </header>

      {/* MAIN */}
      <main className="p-6 space-y-6">
        <h2 className="text-5xl font-light">
          {temp !== null ? temp.toFixed(1) : "--"}°C
        </h2>

        {/* Relay */}
        <div className="flex justify-between items-center bg-zinc-900 p-4 rounded-xl">
          <span>Relay</span>
          <button
            onClick={toggleRelay}
            className={cn(
              "px-4 py-2 rounded-lg",
              relayState === "ON" ? "bg-emerald-500" : "bg-zinc-700"
            )}
          >
            {relayState}
          </button>
        </div>

        {/* Alarm */}
        {isAlarmActive && (
          <div className="bg-red-500 p-4 rounded-xl flex justify-between">
            <span>ALARM ACTIVE</span>
            <button onClick={stopAlarm}>Mute</button>
          </div>
        )}

        {/* Sound */}
        <input type="file" accept="audio/*" onChange={handleSoundUpload} />
      </main>
    </div>
  );
                                }
    client.on("close", () => {
      setIsConnected(false);
      setStatus("DISCONNECTED");
    });

    return () => client.end();
  }, []);

  // 🔔 ALARM LOGIC
  const stopAlarm = useCallback(() => {
    setIsAlarmActive(false);
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (alarmTimer.current) clearTimeout(alarmTimer.current);
  }, []);

  const triggerAlarm = useCallback(async () => {
    if (!settings.alarmEnabled || isAlarmActive) return;

    setIsAlarmActive(true);
    audioRef.current?.play().catch(() => {});

    await notify("🚨 Incubator Alert", `Temperature ${temp}°C (${status})`);

    const duration =
      settings.alarmDurationUnit === "minutes"
        ? settings.alarmDuration * 60000
        : settings.alarmDuration * 1000;

    alarmTimer.current = setTimeout(stopAlarm, duration);
  }, [settings, isAlarmActive, temp, status, stopAlarm]);

  useEffect(() => {
    if (temp === null) return;
    if (
      temp < settings.lowTempThreshold ||
      temp > settings.highTempThreshold
    ) {
      triggerAlarm();
    }
  }, [temp]);

  // 🔌 RELAY TOGGLE
  const toggleRelay = () => {
    if (!mqttClient.current?.connected) return;
    const newState = relayState === "ON" ? "OFF" : "ON";
    mqttClient.current.publish(TOPICS.relayControl, newState);
  };

  // 🔊 SOUND UPLOAD
  const handleSoundUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSettings((s) => ({ ...s, customSoundUrl: URL.createObjectURL(file) }));
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <audio
        ref={audioRef}
        src={
          settings.customSoundUrl ||
          "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
        }
        loop
      />

      {/* HEADER */}
      <header className="p-6 flex justify-between border-b border-zinc-800">
        <div className="flex items-center space-x-3">
          {isConnected ? (
            <Wifi className="text-emerald-500" />
          ) : (
            <WifiOff className="text-red-500" />
          )}
          <div>
            <h1 className="font-bold">Incubator</h1>
            <p className="text-xs">{status}</p>
          </div>
        </div>
        <button onClick={() => setActiveTab(activeTab === "home" ? "settings" : "home")}>
          {activeTab === "home" ? <SettingsIcon /> : <ChevronLeft />}
        </button>
      </header>

      {/* MAIN */}
      <main className="p-6 space-y-6">
        <h2 className="text-5xl font-light">
          {temp !== null ? temp.toFixed(1) : "--"}°C
        </h2>

        {/* RELAY */}
        <div className="flex justify-between bg-zinc-900 p-4 rounded-xl">
          <span>Relay</span>
          <button
            onClick={toggleRelay}
            className={`px-4 py-2 rounded-lg ${
              relayState === "ON" ? "bg-emerald-500" : "bg-zinc-700"
            }`}
          >
            {relayState}
          </button>
        </div>

        {/* ALARM */}
        {isAlarmActive && (
          <div className="bg-red-500 p-4 rounded-xl flex justify-between">
            <span>ALARM ACTIVE</span>
            <button onClick={stopAlarm}>Mute</button>
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === "settings" && (
          <div className="space-y-4">
            <label>Low Temp</label>
            <input
              type="number"
              value={settings.lowTempThreshold}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  lowTempThreshold: parseFloat(e.target.value),
                }))
              }
            />

            <label>High Temp</label>
            <input
              type="number"
              value={settings.highTempThreshold}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  highTempThreshold: parseFloat(e.target.value),
                }))
              }
            />

            <input type="file" accept="audio/*" onChange={handleSoundUpload} />
          </div>
        )}
      </main>
    </div>
  );
}


