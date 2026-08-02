//go:generate go run github.com/ethereum/go-ethereum/cmd/abigen --abi=HelloWorldInstructionSender.abi --bin=HelloWorldInstructionSender.bin --pkg=helloworld --type=HelloWorldInstructionSender --out=autogen.go

package helloworld
