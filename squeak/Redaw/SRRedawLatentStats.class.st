Class {
	#name : #SRRedawLatentStats,
	#superclass : #Object,
	#instVars : [
		'key',
		'dims',
		'rmsMax',
		'motionMax',
		'elementRef',
		'orderBuffer'
	],
	#category : #'Redaw-XR'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats class >> of: frameArrays [
	^ self new computeFrom: frameArrays
]

{
	#category : #computing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> computeFrom: frameArrays [
	"elementRef is full scale for a single value: 2.5 times the RMS over all values."
	| sum sumSq n squares variance ranked |
	dims := frameArrays anyOne first size.
	sum := Float32Array new: dims.
	sumSq := Float32Array new: dims.
	n := 0.
	squares := 0.
	rmsMax := motionMax := 0.001.
	frameArrays do: [:frames | | previous |
		frames do: [:f | | sq |
			sq := f * f.
			sum += f.
			sumSq += sq.
			squares := squares + sq sum.
			n := n + 1.
			rmsMax := rmsMax max: (sq sum / dims) sqrt.
			previous ifNotNil: [| delta |
				delta := f - previous.
				motionMax := motionMax max: ((delta dot: delta) / dims) sqrt].
			previous := f]].
	elementRef := 2.5 * (squares / (n * dims)) sqrt.
	variance := (1 to: dims) collect: [:i | (sumSq at: i) / n - ((sum at: i) / n) squared].
	ranked := (1 to: dims) asArray sort: [:a :b | (variance at: a) >= (variance at: b)].
	orderBuffer := ByteArray new: 512.
	(ranked first: (dims min: 128)) doWithIndex: [:d :i | orderBuffer floatAt: i - 1 * 4 + 1 put: (d - 1) asFloat].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> dims [
	^ dims
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> elementRef [
	^ elementRef
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> key [
	^ key
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> key: anObject [
	key := anObject.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> motionMax [
	^ motionMax
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> orderBuffer [
	^ orderBuffer
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:31'
}
SRRedawLatentStats >> rmsMax [
	^ rmsMax
]
