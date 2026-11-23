Extension { #name : #SRActionSign }

{
	#category : #'*Redaw-XR',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:58'
}
SRActionSign >> redawContains: aGlobalPoint [
	| local |
	local := self globalTransform globalPointToLocal: aGlobalPoint.
	^ local x abs <= (size x / 2 + 5mm) and: [local y abs <= (size y / 2 + 5mm)]
]

{
	#category : #'*Redaw-XR',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:58'
}
SRActionSign >> redawPress [
	"#onRaycast:, which used to run the action, is not sent by anything any more."
	action ifNotNil: [action valueWithEnoughArguments: {self}]
]
