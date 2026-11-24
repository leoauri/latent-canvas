Class {
	#name : #RedawLatentEcho,
	#superclass : #RedawLatentPort,
	#instVars : [
		'hist'
	],
	#category : #'Redaw-Audio'
}

{
	#category : #porting,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentEcho class >> defaults [
	^ Dictionary new at: 'delay' put: 0.5; at: 'feedback' put: 0.5; at: 'gate' put: 0; yourself
]

{
	#category : #porting,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentEcho class >> jsSource [
	^ '({
  meta: {
    desc: ''Latent echo: adds the output from `delay` seconds ago, scaled by `feedback` towards zero, back into each incoming latent frame (per voice). Frames whose vector length is below `gate` are computed (they stay in the echo line) but not sent on. ctx: { msg, state, sampleRate } -> message to send on, or null.'',
    params: {
      delay: { desc: ''Delay time (s)'', widget: Knob, min: 0.05, max: 4, step: 0.01, default: 0.5 },
      feedback: { desc: ''How much of the delayed vector is kept (0 = shrunk to zero, no echo; 1 = repeats forever)'', widget: Knob, min: 0, max: 1, step: 0.01, default: 0.5 },
      gate: { desc: ''Gate threshold: frames with vector length below this are not passed on (0 = off)'', widget: Knob, min: 0, max: 60, step: 0.1, default: 0 },
    },
  },
  transform({ delay, feedback, gate }, { msg, state, sampleRate }) {
    const v = (state[msg.voice] ??= { hist: [] });
    const D = delay * sampleRate;
    const at = msg.start - D;
    let past = null;
    for (let i = v.hist.length - 1; i >= 0; i--) if (v.hist[i].start <= at) { past = v.hist[i]; break; }
    const data = new Float32Array(msg.data);
    if (past && past.data.length === data.length && at - past.start < D) for (let i = 0; i < data.length; i++) data[i] += feedback * past.data[i];
    v.hist.push({ start: msg.start, data });
    const keep = msg.start - D - sampleRate;
    while (v.hist.length > 1 && v.hist[1].start < keep) v.hist.shift();
    let n = 0;
    for (let i = 0; i < data.length; i++) n += data[i] * data[i];
    return Math.sqrt(n) < gate ? null : { ...msg, data };
  },
})'
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentEcho >> resetVoice [
	hist := OrderedCollection new.
]

{
	#category : #transforming,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentEcho >> transform: aFrame sampleRate: samplesPerSecond [
	| delay at past data keep |
	delay := (self param: 'delay') * samplesPerSecond.
	at := aFrame start - delay.
	hist reverseDo: [:each | (past isNil and: [each start <= at]) ifTrue: [past := each]].
	data := aFrame data copy.
	(past notNil and: [past data size = data size and: [at - past start < delay]])
		ifTrue: [data := data + (past data * (self param: 'feedback'))].
	hist addLast: (aFrame withData: data).
	keep := aFrame start - delay - samplesPerSecond.
	[hist size > 1 and: [(hist at: 2) start < keep]] whileTrue: [hist removeFirst].
	^ (data dot: data) sqrt < (self param: 'gate')
		ifTrue: [nil]
		ifFalse: [aFrame withData: data]
]
