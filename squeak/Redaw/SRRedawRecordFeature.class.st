"
Records the microphone (OpenAL capture) while the transport plays, then encodes the take with the session's encoder layer and adds it to the timeline as a clip where the recording started, as an armed latent layer does in the page. Nothing blocks the frame: capture is drained and the encoding polled every frame. The clip's latents are served from the session's peer, so they reach the browsers while the canvas is open.
"
Class {
	#name : #SRRedawRecordFeature,
	#superclass : #SRRedawFeature,
	#instVars : [
		'device',
		'recorded',
		'startT',
		'label',
		'status',
		'lastTry',
		'startY',
		'armed',
		'takes'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature class >> captureRate [
	"The encoder's own rate (encodec 24 kHz): nothing to resample. Other rates work too, the library resamples."
	^ 24000
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature class >> menuLabel [
	^ 'Recording'
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> addClip: latents t: seconds y: inputY encoder: encoder [
	"Like the page's recorder: the input y is the clip's centre line, and the next take goes a lane below."
	self session peer
		addClipLatents: latents
		dim: encoder channels
		rate: encoder frameRate
		t: seconds
		y: inputY - (view clipHeight / 2).
	self playhead ifNotNil: [:playhead | playhead nudgeInput: view clipHeight + 6].
	status := 'rec: added a ', (latents size // 4 // encoder channels / encoder frameRate roundTo: 0.1) printString, 's clip at ', (seconds roundTo: 0.1) printString, 's'.
]

{
	#category : #recording,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:17'
}
SRRedawRecordFeature >> arm [
	"The page's armed state is per machine, not in the document, so this is the Squeak peer's own. Rec while stopped also plays."
	| layer |
	layer := self latentLayer ifNil: [^ status := 'rec: no latent layer in front of the audio input'].
	armed := true.
	status := 'rec: armed ', (layer at: 'name' ifAbsent: ['latent recording']).
	self playhead ifNotNil: [:playhead | playhead isPlaying ifFalse: [playhead play]].
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> clear [
	super clear.
	label := nil
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> closeDevice [
	device ifNil: [^ self].
	[OpenAL alcCaptureStopDevice: device.
	 OpenAL alcCaptureCloseDevice: device] ensure: [device := nil]
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> deactivate [
	armed := false.
	self closeDevice.
	takes removeAll.
]

{
	#category : #recording,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> disarm [
	armed := false.
	self isRecording ifTrue: [self endTake] ifFalse: [status := 'rec: ready'].
	self playhead ifNotNil: [:playhead | playhead isPlaying ifTrue: [playhead stop]].
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> drain [
	"Take what the microphone captured since the last frame."
	| count n bytes |
	count := ExternalType int32_t allocate.
	OpenAL alcGetIntegervDevice: device param: AlDefines alcCaptureSamples size: 1 values: count.
	n := count first.
	n > 0 ifFalse: [^ self].
	bytes := ByteArray new: n * 2.
	OpenAL alcCaptureSamplesDevice: device buffer: bytes samples: n.
	recorded nextPutAll: bytes.
	status := 'rec: recording ', (recorded position / 2 / self class captureRate) truncated printString, 's at ', (startT roundTo: 0.1) printString, 's'
]

{
	#category : #recording,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> endTake [
	"Takes are encoded in order once the encoder is here; a take is {pcm. t. y. job. deadline}."
	| pcm |
	self drain.
	self closeDevice.
	pcm := recorded contents.
	recorded := nil.
	pcm isEmpty ifTrue: [^ status := 'rec: nothing recorded'].
	takes add: {pcm. startT. startY. nil. nil}.
	status := 'rec: encoding ', (pcm size / 2 / self class captureRate roundTo: 0.1) printString, 's'.
]

{
	#category : #recording,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> followTransport [
	"As the page's recorder: an armed layer records while the transport plays, one take per play."
	| playing |
	playing := self playhead notNil and: [self playhead isPlaying].
	(self isRecording and: [playing not or: [self isArmed not]]) ifTrue: [^ self endTake].
	(self isArmed and: [playing and: [self isRecording not]]) ifTrue: [self startTake].
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> initialize [
	super initialize.
	takes := OrderedCollection new.
	status := 'rec: ready'.
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:17'
}
SRRedawRecordFeature >> isArmed [
	^ armed == true
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> isRecording [
	^ device notNil
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:17'
}
SRRedawRecordFeature >> latentLayer [
	"The latent layer the audio input's latents reach first, which the page's armed recording would record into."
	| layers input |
	layers := self session layers.
	input := layers findFirst: [:each | (each at: 'type' ifAbsent: [nil]) = 'audio-in'].
	input = 0 ifTrue: [^ nil].
	^ (layers allButFirst: input) detect: [:each | (each at: 'type' ifAbsent: [nil]) = 'latent'] ifNone: [nil]
]

{
	#category : #layout,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> layout [
	label := SRTextField new
		text: (self plain: status);
		color: (Color r: 1 g: 0.55 b: 0.5);
		scale: 4cm asVector3;
		rotation: SRTextField uprightRotation;
		position: 45cm @ (view canvasExtent y / -2 - 12cm) @ 1cm;
		yourself.
	self addChild: label
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> playhead [
	^ view featureOf: SRRedawPlayheadFeature
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> pollJobs [
	"A take whose encoding never finishes (the library lost the job) is dropped after its deadline, so it does not hold up the next ones."
	| encoder |
	encoder := self session encoderIfReady ifNil: [^ self].
	takes copy do: [:take | (take at: 4) ifNotNil: [:job |
		[(encoder latentsFor: job)
			ifNil: [Time millisecondClockValue > (take at: 5) ifTrue: [
				takes remove: take.
				status := 'rec: encoding the take at ', ((take at: 2) roundTo: 0.1) printString, 's did not finish, dropped']]
			ifNotNil: [:latents |
				takes remove: take.
				self addClip: latents t: (take at: 2) y: (take at: 3) encoder: encoder]]
			on: Error do: [:e |
				takes remove: take ifAbsent: [].
				lastError := e.
				status := 'rec: ', e messageText]]].
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> prefetchEncoder [
	"Start fetching the encoder's files early, so a take is encoded right away; at most once a second."
	(lastTry notNil and: [Time millisecondClockValue - lastTry < 1000]) ifTrue: [^ self].
	lastTry := Time millisecondClockValue.
	self session encoderIfReady
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> refresh [
	"Every frame: capture, then encoding and adding the clips, move on without a relayout."
	label ifNil: [^ true].
	[self followTransport.
	 device ifNotNil: [self drain].
	 self prefetchEncoder.
	 self submitPending.
	 self pollJobs]
		on: Error do: [:e | lastError := e. status := 'rec: ', e messageText. armed := false. self closeDevice].
	label text: (self plain: status).
	^ false
]

{
	#category : #recording,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:17'
}
SRRedawRecordFeature >> startTake [
	"The take starts at the playhead, at its input y."
	| playhead |
	SRAudioObject ensureOpenAL ifFalse: [armed := false. ^ status := 'rec: SqueakXR audio is off (preference Audio enabled)'].
	device := OpenAL
		alcCaptureOpenDeviceDevicename: nil
		frequency: self class captureRate
		format: AlDefines alFormatMono16
		buffersize: self class captureRate * 4.
	(device isNil or: [device isNull]) ifTrue: [device := nil. armed := false. ^ status := 'rec: no microphone'].
	OpenAL alcCaptureStartDevice: device.
	recorded := WriteStream on: (ByteArray new: self class captureRate * 2 * 10).
	playhead := self playhead.
	startT := playhead ifNil: [0] ifNotNil: [playhead time].
	startY := playhead ifNil: [self session yBelowClips + (view clipHeight / 2)] ifNotNil: [playhead inputY].
	status := 'rec: recording at ', (startT roundTo: 0.1) printString, 's'.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> status [
	^ status
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:20'
}
SRRedawRecordFeature >> submitPending [
	| encoder |
	(takes anySatisfy: [:take | (take at: 4) isNil]) ifFalse: [^ self].
	encoder := self session encoderIfReady ifNil: [
		status := self session encoderLayer
			ifNil: ['rec: looking for the encoder layer']
			ifNotNil: ['rec: fetching the encoder from the room'].
		^ self].
	takes do: [:take | (take at: 4) ifNil: [| seconds |
		seconds := (take at: 1) size / 2 / self class captureRate.
		take at: 4 put: (encoder submit: (take at: 1) rate: self class captureRate).
		take at: 5 put: Time millisecondClockValue + (30000 + (seconds * 1000)) rounded.
		take at: 1 put: nil]].
]

{
	#category : #toggle,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 15:17'
}
SRRedawRecordFeature >> toggle [
	self isArmed ifTrue: [self disarm] ifFalse: [self arm].
]

{
	#category : #updating,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> update [
	^ false
]
