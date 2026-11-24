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
		'pending',
		'job',
		'jobT',
		'label',
		'status',
		'lastTry'
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
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> deactivate [
	self closeDevice.
	pending := nil.
	job := nil
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
	#category : #'initialize-release',
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> initialize [
	super initialize.
	status := 'rec: ready'
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> isRecording [
	^ device notNil
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
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> pollJob [
	| encoder latents id |
	encoder := self session encoderIfReady.
	latents := (encoder latentsFor: job) ifNil: [^ self].
	job := nil.
	id := self session peer
		addClipLatents: latents
		dim: encoder channels
		rate: encoder frameRate
		t: jobT
		y: self session yBelowClips.
	status := 'rec: added a ', (latents size // 4 // encoder channels / encoder frameRate roundTo: 0.1) printString, 's clip at ', (jobT roundTo: 0.1) printString, 's'.
	^ id
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
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> refresh [
	"Every frame: capture, then encoding and adding the clip, move on without a relayout."
	label ifNil: [^ true].
	[device ifNotNil: [self drain].
	 self prefetchEncoder.
	 pending ifNotNil: [self submitPending].
	 job ifNotNil: [self pollJob]]
		on: Error do: [:e | lastError := e. status := 'rec: ', e messageText. self closeDevice. pending := job := nil].
	label text: (self plain: status).
	^ false
]

{
	#category : #recording,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> start [
	"Open the microphone and start the transport (unless it plays): the take starts at the playhead."
	| playhead |
	self isRecording ifTrue: [^ self].
	(pending notNil or: [job notNil]) ifTrue: [^ status := 'rec: still encoding the last take'].
	SRAudioObject ensureOpenAL ifFalse: [^ status := 'rec: SqueakXR audio is off (preference Audio enabled)'].
	device := OpenAL
		alcCaptureOpenDeviceDevicename: nil
		frequency: self class captureRate
		format: AlDefines alFormatMono16
		buffersize: self class captureRate * 4.
	(device isNil or: [device isNull]) ifTrue: [device := nil. ^ status := 'rec: no microphone'].
	OpenAL alcCaptureStartDevice: device.
	recorded := WriteStream on: (ByteArray new: self class captureRate * 2 * 10).
	playhead := self playhead.
	(playhead notNil and: [playhead isPlaying not]) ifTrue: [playhead play].
	startT := playhead ifNil: [0] ifNotNil: [playhead time].
	status := 'rec: recording at ', (startT roundTo: 0.1) printString, 's'
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> status [
	^ status
]

{
	#category : #recording,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> stop [
	"Stop the microphone and the transport; the take is encoded and added once the encoder is here."
	| pcm |
	self isRecording ifFalse: [^ self].
	self drain.
	self closeDevice.
	self playhead ifNotNil: [:playhead | playhead isPlaying ifTrue: [playhead stop]].
	pcm := recorded contents.
	recorded := nil.
	pcm isEmpty ifTrue: [^ status := 'rec: nothing recorded'].
	pending := pcm.
	jobT := startT.
	status := 'rec: encoding ', (pcm size / 2 / self class captureRate roundTo: 0.1) printString, 's'
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:52'
}
SRRedawRecordFeature >> submitPending [
	| encoder |
	encoder := self session encoderIfReady ifNil: [
		status := self session encoderLayer
			ifNil: ['rec: looking for the encoder layer']
			ifNotNil: ['rec: fetching the encoder from the room'].
		^ self].
	job := encoder submit: pending rate: self class captureRate.
	pending := nil
]

{
	#category : #recording,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> toggle [
	self isRecording ifTrue: [self stop] ifFalse: [self start]
]

{
	#category : #updating,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
SRRedawRecordFeature >> update [
	^ false
]
