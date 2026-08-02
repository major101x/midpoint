// Command start-tee runs the tee-node and the Go extension as a single host
// process, without Docker. It backs `./scripts/start-services.sh --local`.
//
// This lives in the extension module (not tools/) because it links the Go
// extension in-process — it is a Go-path development convenience, not
// deployment tooling. tools/ must stay independent of any one language
// implementation so that it can deploy and test all of them; see
// docs/extension-contract.md.
//
// Consequently `--local` mode is Go-only. start-services.sh rejects it for
// other languages and points at Docker Compose instead.
package main

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	extserver "extension-scaffold/pkg/server"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teeServer "github.com/flare-foundation/tee-node/pkg/server"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	"github.com/joho/godotenv"
)

// Port constants matching the extension-e2e configs.
const (
	ExtConfigurationPort = 5501 // TEE configuration port (proxyURL, initialOwner, extensionID)
	ExtProxyInternalPort = 6663 // Internal port: TEE polls actions from proxy queue
	ExtensionServerPort  = 7701 // TEE signing port: extension calls TEE for signing/encrypting
	ExtensionPort        = 7702 // Extension server port: TEE forwards POST /action here
)

func main() {
	extensionID := flag.String("extensionID", "", "extension ID (bytes32 hex)")
	flag.Parse()

	signalChan := make(chan os.Signal, 1)
	signal.Notify(signalChan, os.Interrupt, syscall.SIGTERM)

	loadEnv()

	_ = setOwnerAddress()

	if *extensionID != "" {
		os.Setenv("EXTENSION_ID", *extensionID)
	}

	runExtension()

	sig := <-signalChan
	logger.Infof("Received %v signal, shutting down", sig)
}

func loadEnv() {
	// Try project-root .env first (works even when CWD is elsewhere).
	_, thisFile, _, _ := runtime.Caller(0)
	rootEnv := filepath.Join(filepath.Dir(thisFile), "..", "..", ".env")
	if err := godotenv.Load(rootEnv); err != nil {
		// Fallback to CWD .env.
		if err := godotenv.Load(); err != nil {
			fmt.Printf("Warning: Error loading .env file: %v\n", err)
		}
	}
}

func runExtension() {
	// Start tee-node in extension mode.
	go teeServer.StartServerExtension(ExtConfigurationPort, ExtensionServerPort, ExtensionPort)

	// Start extension server — fail fast if port binding fails.
	extErrCh := extserver.StartExtension(ExtensionPort, ExtensionServerPort)

	// Give server a moment to bind, then check for early failures.
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-extErrCh:
		logger.Fatalf("extension server failed to start: %v", err)
	default:
	}

	logger.Infof("Starting extension TEE on port %d", ExtConfigurationPort)

	time.Sleep(150 * time.Millisecond)

	err := setProxyURL(ExtConfigurationPort, ExtProxyInternalPort)
	if err != nil {
		logger.Fatalf("Error: %v", err)
	}
}

// setProxyURL points the freshly started node at the local extension proxy.
// Inlined from tools/pkg/fccutils so this command carries no dependency on the
// tools module.
func setProxyURL(configurationPort, proxyPort int) error {
	url := fmt.Sprintf("http://localhost:%d", proxyPort)
	request := teetypes.ConfigureProxyURLRequest{URL: &url}

	body, err := json.Marshal(request)
	if err != nil {
		return err
	}

	url = fmt.Sprintf("http://localhost:%d/proxy", configurationPort)
	logger.Infof("Setting proxy url on tee: %s", url)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	return nil
}

func setOwnerAddress() common.Address {
	owner := os.Getenv("INITIAL_OWNER")
	if owner == "" {
		var privKey *ecdsa.PrivateKey
		var err error
		privKeyString := os.Getenv("DEPLOYMENT_PRIVATE_KEY")
		if privKeyString == "" {
			// Default Hardhat-funded key.
			privKey, err = crypto.HexToECDSA("804b01a8c27a65cc694a867be76edae3ccce7a7161cda1f67a8349df696d2207")
			if err != nil {
				panic("cannot parse default private key")
			}
		} else {
			if strings.HasPrefix(privKeyString, "0x") || strings.HasPrefix(privKeyString, "0X") {
				privKeyString = privKeyString[2:]
			}
			privKey, err = crypto.HexToECDSA(privKeyString)
			if err != nil {
				logger.Fatalf("Error: %v", err)
			}
		}

		ownerAddress := crypto.PubkeyToAddress(privKey.PublicKey)
		os.Setenv("INITIAL_OWNER", ownerAddress.String())
	}

	return common.HexToAddress(owner)
}
