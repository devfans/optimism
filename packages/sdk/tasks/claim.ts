import { task, types } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { Wallet, providers, Contract, ethers, BigNumber } from 'ethers'
import 'hardhat-deploy'
import '@nomiclabs/hardhat-ethers'
import {
    encodeCrossDomainMessageV1,
    decodeVersionedNonce,
    toRpcHexString
  } from '@eth-optimism/core-utils'

import { getContractInterface as getContractInterfaceBedrock } from '@eth-optimism/contracts-bedrock'

import {
    MessageDirection,
} from '../src/interfaces'

task('claim', 'Finalize a withdrawal')
.addParam(
    'transactionHash',
    'L2 Transaction hash to finalize',
    '',
    types.string
  )
.setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const txHash = args.transactionHash
    if (txHash === '') {
      console.log('No tx hash')
    }

    const l1Provider = new providers.StaticJsonRpcProvider("http://localhost:22001")
    const signer = new Wallet(process.env.PRIVATE_KEY_CLAIMER, l1Provider)
    const address = await signer.getAddress()
    console.log(`Using signer: ${address}`)

    const l2Provider = new providers.StaticJsonRpcProvider("http://localhost:8645")

    const l2OutputOracle = new Contract(
        "0x5bCa1AC46bdcD9812638f12aD32686cB674bF1F8",
        getContractInterfaceBedrock("L2OutputOracle"),
        l1Provider
    )

    const optimismPortal = new Contract(
        "0xa7f5460Ce599366dcC770084DD219443EC3dA2F6",
        getContractInterfaceBedrock("OptimismPortal"),
        l1Provider
    )

    const messenger = new Contract(
        "0x4200000000000000000000000000000000000007",
        getContractInterfaceBedrock("L2CrossDomainMessenger"),
        l2Provider
    )

    const l2ToL1MessagePasser = new Contract(
        "",
        getContractInterfaceBedrock("L2ToL1MessagePasser"),
        l2Provider
    )

    const receipt = await l2Provider.getTransactionReceipt(txHash)

    const message = receipt.logs
      .filter((log) => {
        // Only look at logs emitted by the messenger address
        return log.address === messenger.address
      })
      .filter((log) => {
        // Only look at SentMessage logs specifically
        const parsed = messenger.interface.parseLog(log)
        return parsed.name === 'SentMessage'
      })
      .map((log) => {
        // Try to pull out the value field, but only if the very next log is a SentMessageExtension1
        // event which was introduced in the Bedrock upgrade.
        let value = ethers.BigNumber.from(0)
        const next = receipt.logs.find((l) => {
          return (
            l.logIndex === log.logIndex + 1 && l.address === messenger.address
          )
        })
        if (next) {
          const nextParsed = messenger.interface.parseLog(next)
          if (nextParsed.name === 'SentMessageExtension1') {
            value = nextParsed.args.value
          }
        }

        // Convert each SentMessage log into a message object
        const parsed = messenger.interface.parseLog(log)
        return {
          direction: MessageDirection.L2_TO_L1,
          target: parsed.args.target,
          sender: parsed.args.sender,
          message: parsed.args.message,
          messageNonce: parsed.args.messageNonce,
          value,
          minGasLimit: parsed.args.gasLimit,
          logIndex: log.logIndex,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
        }
      })[0]

    const { version } = decodeVersionedNonce(message.messageNonce)
    console.log("Version", version)

    const l2OutputIndex =
        await l2OutputOracle.getL2OutputIndexAfter(
          receipt.blockNumber
        )
    const proposal = await l2OutputOracle.getL2Output(
        l2OutputIndex
      )

      // Format everything and return it nicely.
    const output = {
        outputRoot: proposal.outputRoot,
        l1Timestamp: proposal.timestamp.toNumber(),
        l2BlockNumber: proposal.l2BlockNumber.toNumber(),
        l2OutputIndex: l2OutputIndex.toNumber(),
      }

    const block = await (
        l2Provider as ethers.providers.JsonRpcProvider
      ).send('eth_getBlockByNumber', [
        toRpcHexString(output.l2BlockNumber),
        false,
      ])

    const updated = message;
    const withdrawal = {
        messageNonce: updated.messageNonce,
        sender: "0x4200000000000000000000000000000000000007",
        target: "0xe25e55006E03Fd658Ab27AE5E6024558Ce54714E",
        value: updated.value,
        minGasLimit: BigNumber.from(0),
        message: encodeCrossDomainMessageV1(
          updated.messageNonce,
          updated.sender,
          updated.target,
          updated.value,
          updated.minGasLimit,
          updated.message
        ),
      }
    {
        const withdrawals: any[] = []
        for (const log of receipt.logs) {
        if (log.address === "0x4200000000000000000000000000000000000016") {
            const decoded =
            l2ToL1MessagePasser.interface.parseLog(log)
            if (decoded.name === 'MessagePassed') {
            withdrawals.push(decoded.args)
            }
        }
        }

        // Should not happen.
        if (withdrawals.length === 0) {
        throw new Error(`no withdrawals found in receipt`)
        }

        // TODO: Add support for multiple withdrawals.
        if (withdrawals.length > 1) {
        throw new Error(`multiple withdrawals found in receipt`)
        }

        const w = withdrawals[0]
        withdrawal.messageNonce = w.nonce
        withdrawal.minGasLimit = w.gasLimit
    }

    const param = await optimismPortal.populateTransaction.finalizeWithdrawalTransaction(
          [
            withdrawal.messageNonce,
            withdrawal.sender,
            withdrawal.target,
            withdrawal.value,
            withdrawal.minGasLimit,
            withdrawal.message,
          ],
          {}
        )

      const tx = await signer.sendTransaction(
        param
      )
      await tx.wait()
})