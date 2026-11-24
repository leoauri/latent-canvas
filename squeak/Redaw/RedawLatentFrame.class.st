"
One message of a latent stream between layer functions, as models.js passes them: a frame, the context frame (sample) it starts at, its frames per second.
"
Class {
	#name : #RedawLatentFrame,
	#superclass : #Object,
	#instVars : [
		'data',
		'start',
		'rate'
	],
	#category : #'Redaw-Audio',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame class >> data: aFloatArray start: samples rate: framesPerSecond [
	^ self new setData: aFloatArray start: samples rate: framesPerSecond
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> data [
	^ data
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> isAudible [
	"models.js: a function layer's tail goes on while its output has any |x| > 1e-3."
	^ data anySatisfy: [:x | x abs > 1.0e-3]
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> isSilent [
	^ data allSatisfy: [:x | x = 0]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> rate [
	^ rate
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> setData: aFloatArray start: samples rate: framesPerSecond [
	data := aFloatArray.
	start := samples.
	rate := framesPerSecond.
]

{
	#category : #copying,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> silenceAfter: samples [
	"The zero frame the page's host sends a layer when its input stopped (tails)."
	^ self class data: (FloatArray new: data size) start: start + samples rate: rate
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> start [
	^ start
]

{
	#category : #copying,
	#'squeak_changestamp' : 'jl-MCPServer 11/24/2026 17:02'
}
RedawLatentFrame >> withData: aFloatArray [
	^ self class data: aFloatArray start: start rate: rate
]
