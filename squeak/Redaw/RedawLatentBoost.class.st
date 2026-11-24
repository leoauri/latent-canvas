Class {
	#name : #RedawLatentBoost,
	#superclass : #RedawLatentPort,
	#category : #'Redaw-Audio'
}

{
	#category : #porting,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentBoost class >> defaults [
	^ Dictionary new at: 'db' put: 6; yourself
]

{
	#category : #porting,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentBoost class >> jsSource [
	^ '({
  meta: {
    desc: ''Latent-space boost: pushes each frame away from the encoder\''s silence latent S, v\'' = S + (1+k)(v−S), with k fitted to real re-encodes of boosted audio (k ≈ 0.0313·dB + 0.000264·dB², i.e. +6 dB → 0.20, +12 dB → 0.41, +26 dB → 1.0). Negative dB pulls towards silence. Captures ~30% of what a real boost does (the shared loudness direction); timbre changes at large gains are not modelled. All-zero frames are dropped (they decode to a buzz). ctx: { msg }.'',
    params: {
      db: { desc: ''Boost (dB, approx.)'', widget: Knob, min: -24, max: 30, step: 0.5, default: 6 },
    },
  },
  transform({ db }, { msg }) {
    const S = [-0.7026,8.568,-3.5112,-1.6131,-0.8768,5.2806,-1.3717,-0.2062,-2.8369,1.7965,0.743,0.3364,1.1352,-4.6924,-1.1059,-4.6147,0.812,1.8561,-1.8385,0.3737,-9.864,-4.9325,-3.6009,0.535,4.9655,-0.4477,6.0063,-3.9666,-3.6699,-2.38,-5.3494,3.5392,2.8856,-1.5775,2.4089,-3.2056,-3.4863,-6.6524,0.4765,1.8669,5.3892,2.6841,9.6871,2.6024,0.9259,-2.4023,-3.5475,1.6296,2.0041,-3.7135,-2.2713,-4.9514,0.2138,0.8579,-2.9825,0.2096,-0.6594,-4.2097,-0.6735,0.4161,-6.3095,-4.303,0.05,-1.5417,-5.4577,-0.8784,0.486,-2.5928,0.4708,2.7299,-0.9351,-5.2891,-0.5134,-2.254,-3.1415,-10.1942,3.3995,-2.1455,-3.8459,0.7058,-1.2844,-5.094,-6.5189,2.5326,1.5414,-1.8417,0.4106,-0.553,3.1918,-1.604,10.2026,5.3634,0.6503,2.4892,-6.2672,6.1241,1.1466,11.5863,0.0333,2.3464,1.7934,5.6317,3.6287,-1.8468,-7.3632,-0.7196,-1.3525,-1.1601,-2.0617,3.2477,-8.1955,0.2117,-5.5009,0.4804,-4.3802,0.8597,-0.9175,-2.0735,0.2089,-2.6734,0.5412,-1.1922,-1.2379,2.0291,-1.8136,-0.613,-1.8007,1.7306];
    if (msg.kind !== ''latent'') return msg;
    if (!msg.data.some((x) => x !== 0)) return null;
    if (msg.data.length !== S.length || !db) return msg;
    const k = Math.max(-1, 0.0313 * db + 0.000264 * db * Math.abs(db));
    const data = new Float32Array(S.length);
    for (let i = 0; i < S.length; i++) data[i] = S[i] + (1 + k) * (msg.data[i] - S[i]);
    return { ...msg, data };
  },
})'
]

{
	#category : #constants,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentBoost class >> silence [
	^ self constant: 'S'
]

{
	#category : #transforming,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentBoost >> transform: aFrame sampleRate: samplesPerSecond [
	| silence db k |
	aFrame isSilent ifTrue: [^ nil].
	silence := self class silence.
	db := self param: 'db'.
	(aFrame data size ~= silence size or: [db = 0]) ifTrue: [^ aFrame].
	k := -1 max: (0.0313 * db) + (0.000264 * db * db abs).
	^ aFrame withData: silence + ((aFrame data - silence) * (1 + k))
]
