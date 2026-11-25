Class {
	#name : #SRRedawLatentPanel,
	#superclass : #SRObject,
	#instVars : [
		'canvas',
		'display'
	],
	#category : #'Redaw-XR'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel class >> for: aSessionView [
	^ self new setCanvas: aSessionView
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> addButton: aString at: x y: y do: aBlock [
	"The button passes the trigger on to me, I find the button under the hit point."
	| button |
	button := SRActionSign new
		size: 9cm @ 4.5cm @ 1.5cm;
		label: aString;
		slabColor: (Color r: 0.15 g: 0.35 b: 0.6);
		action: aBlock;
		grabTarget: self;
		cursorMode: SRCursorMode pass;
		translation: x @ y @ (self size z / 2 + 0.75cm);
		yourself.
	self addChild: button.
	^ button
]

{
	#category : #menus,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> addCustomMenuItemsTo: aMenu [
	canvas ifNotNil: [canvas addCustomMenuItemsTo: aMenu]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> buttonRows [
	^ #(
		#(#('Colour' #cycleColour) #('Height' #cycleHeight) #('Dims on' #cyclePlace) #('Gap' #cycleGap))
		#(#('Count' #cycleCount) #('Order' #toggleOrder) #('Grid' #toggleGrid) #('Mark dim' #toggleHighlight))
		#(#('Dim -' #previousDim) #('Dim +' #nextDim) #('Dim -8' #previousDims) #('Dim +8' #nextDims))
		#(#('Gain -' #lessGain) #('Gain +' #moreGain) #('Lower' #lower) #('Higher' #higher)))
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> canvas [
	^ canvas
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> collisionGeometry [
	^ SRCollisionBox new
		center: self globalTranslation;
		halfExtents: self size / 2;
		rotation: self globalRotation;
		object: self
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:36'
}
SRRedawLatentPanel >> initialize [
	"SRTextField draws one line: a field per line."
	super initialize.
	self name: 'Latent view'.
	self addChild: (SRCube new
		drawWires: false;
		color: (Color gray: 0.18);
		ignoreCollision: true;
		scale: self size;
		yourself).
	display := (1 to: 4) collect: [:i |
		self addChild: (SRTextField new
			text: '';
			color: Color white;
			scale: 1.2cm asVector3;
			rotation: SRTextField uprightRotation;
			position: (self size x / -2 + 1.5cm) @ (self size y / 2 - (i * 1.6cm)) @ (self size z / 2 + 1mm);
			yourself)].
	self buttonRows doWithIndex: [:row :y |
		row doWithIndex: [:spec :x |
			self
				addButton: spec first
				at: x - 2.5 * 9.8cm
				y: 7cm - (y - 1 * 5.5cm)
				do: [self style ifNotNil: [:style | style perform: spec second]]]].
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> isApp [
	^ true
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> onButtonPress: anEvent [
	anEvent button == #trigger ifFalse: [^ self].
	(self children
		detect: [:each | (each isKindOf: SRActionSign) and: [each redawContains: anEvent point]]
		ifNone: [nil]) ifNotNil: [:button | button redawPress]
]

{
	#category : #placing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> placeAt: aPosition facing: aCamera [
	| toward yaw |
	toward := aCamera globalTranslation - aPosition.
	yaw := (toward x arcTan: toward z) radiansToDegrees.
	self rotation: (Quaternion angle: yaw axis: Vector3 up).
	self translation: aPosition
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> setCanvas: aSessionView [
	canvas := aSessionView.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> size [
	^ 42cm @ 34cm @ 3cm
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:36'
}
SRRedawLatentPanel >> step: deltaTime [
	"Runs in the world process: an error here must not reach a debugger."
	[| lines |
	 lines := self style ifNil: [#('No clips feature' '' '' '')] ifNotNil: [:style | style summaryLines].
	 display with: lines do: [:field :line | line = field text ifFalse: [field text: line]]]
		on: Error do: [:e | display first text: 'Latent view: ', e messageText].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> style [
	^ canvas ifNotNil: [(canvas featureOf: SRRedawClipsFeature) ifNotNil: [:feature | feature style]]
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> wantsGrab [
	^ true
]
