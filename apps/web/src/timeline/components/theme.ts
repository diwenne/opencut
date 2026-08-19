import type { TrackType } from "@/timeline";

// White reads well on the audio track's purple element, but video elements are
// transparent and fall back to this default, where white is invisible against a
// light timeline. Resolved per theme instead of hardcoded.
export const TIMELINE_AUDIO_WAVEFORM_COLOR = "rgba(255, 255, 255, 0.7)";
export const TIMELINE_AUDIO_WAVEFORM_COLOR_LIGHT = "rgba(24, 24, 27, 0.55)";

export function getDefaultWaveformColor({
	isDark,
}: {
	isDark: boolean;
}): string {
	return isDark
		? TIMELINE_AUDIO_WAVEFORM_COLOR
		: TIMELINE_AUDIO_WAVEFORM_COLOR_LIGHT;
}

export const TIMELINE_TRACK_THEME: Record<
	TrackType,
	{
		elementClassName: string;
		waveformColor?: string;
	}
> = {
	video: { elementClassName: "transparent" },
	text: { elementClassName: "bg-[#5DBAA0]" },
	audio: {
		elementClassName: "bg-[#8F5DBA]",
		waveformColor: TIMELINE_AUDIO_WAVEFORM_COLOR,
	},
	graphic: { elementClassName: "bg-[#BA5D7A]" },
	effect: { elementClassName: "bg-[#5d93ba]" },
} as const;

export const SELECTED_TRACK_ROW_CLASS = "bg-accent/50";
export const DEFAULT_TIMELINE_BOOKMARK_COLOR = "#009dff";

export function getTimelineElementClassName({
	type,
}: {
	type: TrackType;
}): string {
	return TIMELINE_TRACK_THEME[type].elementClassName.trim();
}
