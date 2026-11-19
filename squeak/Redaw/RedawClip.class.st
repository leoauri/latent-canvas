"
A latent clip on a redaw session's timeline (state/timeline.clips): where it is (t: start in seconds, y: vertical position), its sample rate (frames per second), dimensionality, length in frames, and its latents.

The latents live in the session's blob store under dataHash (little-endian float32, frame-major). frames is an Array of FloatArrays, one per frame of dim values, once the blob has arrived from the room; state tells where it is ('absent', 'waiting', 'fetching', 'done').

RedawSession keeps its clips up to date; RedawPeer>>latentsAt:dim: reads latents directly.
"
Class {
	#name : #RedawClip,
	#superclass : #Object,
	#instVars : [
		'id',
		't',
		'y',
		'rate',
		'dim',
		'length',
		'dataHash',
		'frames',
		'state'
	],
	#category : #'Redaw-Peer',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip class >> framesFrom: aByteArray dim: anInteger [
	"Little-endian float32 values, frame-major, as an Array of FloatArrays of anInteger values each."
	| n values |
	anInteger < 1 ifTrue: [^ #()].
	n := aByteArray size // 4.
	values := FloatArray new: n.
	1 to: n do: [:i | values basicAt: i put: (aByteArray unsignedLongAt: i - 1 * 4 + 1 bigEndian: false)].
	^ (1 to: n // anInteger) collect: [:f | values copyFrom: f - 1 * anInteger + 1 to: f * anInteger]
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip class >> fromJson: aJsonObject [
	^ self new updateFrom: aJsonObject; yourself
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> dataHash [
	^ dataHash
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> dim [
	^ dim
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> dimension: d [
	"The values of dimension d (1-based) over time, as a FloatArray."
	^ frames ifNotNil: [FloatArray withAll: (frames collect: [:f | f at: d])]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> duration [
	"In seconds."
	^ (length isNil or: [rate isNil or: [rate = 0]]) ifTrue: [0] ifFalse: [length / rate]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> frameAt: index [
	^ frames ifNotNil: [frames at: index]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> frames [
	"An Array of FloatArrays (one per frame, dim values each), or nil until the latents arrived."
	^ frames
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> id [
	^ id
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> isLoaded [
	^ frames notNil
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> length [
	"Number of frames."
	^ length
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> loadFrom: aRedawPeer [
	"Fetch the clip's latents from the room if they are not here; take them once they are."
	| status |
	(frames notNil or: [dataHash isNil]) ifTrue: [^ self].
	(aRedawPeer latentsAt: dataHash dim: dim) ifNotNil: [:f | frames := f. state := 'done'. ^ self].
	aRedawPeer fetchBlob: dataHash.
	status := aRedawPeer blobStatus: dataHash.
	state := (status at: 'state' ifAbsent: ['?']), ((status at: 'total' ifAbsent: [0]) > 0
		ifTrue: [' ', (status at: 'bytes') printString, '/', (status at: 'total') printString]
		ifFalse: [''])
]

{
	#category : #printing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> printOn: aStream [
	aStream nextPutAll: 'a RedawClip('.
	t ifNotNil: [aStream print: (t roundTo: 0.01); nextPutAll: 's, '].
	aStream print: length; nextPutAll: ' x '; print: dim; nextPutAll: ' @ '; print: (rate ifNil: [0] ifNotNil: [rate roundTo: 0.01]); nextPutAll: '/s, '.
	aStream nextPutAll: (frames ifNil: [state ifNil: ['?']] ifNotNil: ['loaded']); nextPut: $)
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> rate [
	"Frames per second."
	^ rate
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> state [
	^ state
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> t [
	"Start on the timeline, in seconds."
	^ t
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> updateFrom: aJsonObject [
	"Take the clip's metadata from the document. Answers whether its data changed (frames are then dropped until the new blob arrives)."
	| hash |
	id := aJsonObject at: 'id' ifAbsent: [id].
	t := aJsonObject at: 't' ifAbsent: [t].
	y := aJsonObject at: 'y' ifAbsent: [y].
	rate := aJsonObject at: 'rate' ifAbsent: [rate].
	dim := aJsonObject at: 'dim' ifAbsent: [dim].
	length := aJsonObject at: 'length' ifAbsent: [length].
	hash := aJsonObject at: 'dataHash' ifAbsent: [nil].
	hash = dataHash ifTrue: [^ false].
	dataHash := hash.
	frames := nil.
	state := hash ifNil: ['no data'] ifNotNil: ['absent'].
	^ true
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawClip >> y [
	^ y
]
