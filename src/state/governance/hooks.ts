import { TransactionResponse } from '@ethersproject/providers'
import { TokenAmount, Token, Percent } from '@uniswap/sdk'
import {
  updateActiveProtocol,
  updateFilterActive,
  updateTopDelegates,
  updateVerifiedDelegates,
  updateGlobalData,
  updateMaxFetched
} from './actions'
import { AppDispatch, AppState } from './../index'
import { useDispatch, useSelector } from 'react-redux'
import { GovernanceInfo, GlobaData } from './reducer'
import { useState, useEffect, useCallback } from 'react'
import {
  useGovernanceContract,
  useGovTokenContract,
  isAaveGov,
  isAaveToken,
  isAaveTokenContract
} from '../../hooks/useContract'
import { useSingleCallResult, useSingleContractMultipleData, NEVER_RELOAD } from '../multicall/hooks'
import { useActiveWeb3React } from '../../hooks'
import { useTransactionAdder } from '../transactions/hooks'
import { isAddress, calculateGasMargin } from '../../utils'
import { useSubgraphClient } from '../application/hooks'
import { fetchProposals, enumerateProposalState } from '../../data/governance'
import { ALL_VOTERS, DELEGATE_INFO } from '../../apollo/queries'
import { deserializeToken } from '../user/hooks'
import { useIsEOA } from '../../hooks/useIsEOA'
import { AUTONOMOUS_PROPOSAL_BYTECODE } from '../../constants/proposals'

export interface DelegateData {
  id: string
  delegatedVotes: number
  delegatedVotesRaw: number
  votePercent: Percent
  votes: {
    id: string
    support: boolean
    votes: number
  }[]
  EOA: boolean | undefined //
  autonomous: boolean | undefined
  handle: string | undefined // twitter handle
  imageURL?: string | undefined
}

export function useActiveProtocol(): [GovernanceInfo | undefined, (activeProtocol: GovernanceInfo) => void] {
  const dispatch = useDispatch<AppDispatch>()
  const activeProtocol = useSelector<AppState, AppState['governance']['activeProtocol']>(state => {
    return state.governance.activeProtocol
  })

  const setActiveProtocol = useCallback(
    (activeProtocol: GovernanceInfo) => {
      dispatch(updateActiveProtocol({ activeProtocol }))
    },
    [dispatch]
  )
  return [activeProtocol, setActiveProtocol]
}

export function useFilterActive(): [boolean, (filterActive: boolean) => void] {
  const dispatch = useDispatch<AppDispatch>()
  const filterActive = useSelector<AppState, AppState['governance']['filterActive']>(state => {
    return state.governance.filterActive
  })

  const setFilterActive = useCallback(
    (filterActive: boolean) => {
      dispatch(updateFilterActive({ filterActive }))
    },
    [dispatch]
  )
  return [filterActive, setFilterActive]
}

export function useGovernanceToken(): Token | undefined {
  const { chainId } = useActiveWeb3React()
  const [activeProtocol] = useActiveProtocol()
  return chainId && activeProtocol ? deserializeToken(activeProtocol.token) : undefined
}

// @todo add typed query response
export function useGlobalData(): [GlobaData | undefined, (data: GlobaData | undefined) => void] {
  const dispatch = useDispatch<AppDispatch>()

  const [activeProtocol] = useActiveProtocol()

  const globalData = useSelector<AppState, AppState['governance']['globalData']>(state => state.governance.globalData)

  const setGlobalData = useCallback(
    (data: GlobaData | undefined) => {
      activeProtocol && dispatch(updateGlobalData({ protocolID: activeProtocol.id, data }))
    },
    [activeProtocol, dispatch]
  )

  return [activeProtocol ? globalData[activeProtocol.id] : undefined, setGlobalData]
}

export function useMaxFetched(): [number | undefined, (maxFetched: number | undefined) => void] {
  const dispatch = useDispatch<AppDispatch>()

  const [activeProtocol] = useActiveProtocol()

  const maxFetched = useSelector<AppState, AppState['governance']['maxFetched']>(state => state.governance.maxFetched)

  const setMaxFetched = useCallback(
    (maxFetched: number | undefined) => {
      activeProtocol && dispatch(updateMaxFetched({ protocolID: activeProtocol.id, maxFetched }))
    },
    [activeProtocol, dispatch]
  )

  return [activeProtocol ? maxFetched[activeProtocol.id] : undefined, setMaxFetched]
}

export function useTopDelegates(): [DelegateData[] | undefined, (topDelegates: DelegateData[] | undefined) => void] {
  const [activeProtocol] = useActiveProtocol()

  const dispatch = useDispatch<AppDispatch>()
  const delegates = useSelector<AppState, AppState['governance']['topDelegates']>(state => {
    return state.governance.topDelegates
  })
  const setTopDelegates = useCallback(
    (topDelegates: DelegateData[] | undefined) => {
      activeProtocol && dispatch(updateTopDelegates({ protocolID: activeProtocol?.id, topDelegates }))
    },
    [activeProtocol, dispatch]
  )
  return [activeProtocol ? delegates?.[activeProtocol.id] : undefined, setTopDelegates]
}

export function useVerifiedDelegates(): [
  DelegateData[] | undefined,
  (verifiedDelegates: DelegateData[] | undefined) => void
] {
  const [activeProtocol] = useActiveProtocol()

  const dispatch = useDispatch<AppDispatch>()
  const delegates = useSelector<AppState, AppState['governance']['verifiedDelegates']>(state => {
    return state.governance.verifiedDelegates
  })
  const setVerifiedDelegates = useCallback(
    (verifiedDelegates: DelegateData[] | undefined) => {
      activeProtocol && dispatch(updateVerifiedDelegates({ protocolID: activeProtocol?.id, verifiedDelegates }))
    },
    [activeProtocol, dispatch]
  )
  return [activeProtocol ? delegates?.[activeProtocol.id] : undefined, setVerifiedDelegates]
}

interface ProposalDetail {
  target: string
  functionSig: string
  callData: string
}

export interface ProposalData {
  id: string
  title: string
  description: string
  proposer: string
  status: string
  forCount: number | undefined
  againstCount: number | undefined
  startBlock: number
  endBlock: number
  details: ProposalDetail[]
  forVotes: {
    support: boolean
    votes: string
    voter: {
      id: string
    }
  }[]
  againstVotes: {
    support: boolean
    votes: string
    voter: {
      id: string
    }
  }[]
}

// get count of all proposals made
export function useProposalCount(): number | undefined {
  const gov = useGovernanceContract()
  const res = useSingleCallResult(gov, isAaveGov(gov) ? 'getProposalsCount' : 'proposalCount')
  if (res.result && !res.loading) {
    return parseInt(res.result[0])
  }
  return undefined
}

/**
 * @TODO can this be used to speed up the loading?
 */
export function useAllProposalStates(): number[] | undefined {
  const govContract = useGovernanceContract()

  const [statuses, setStatuses] = useState<number[] | undefined>()
  const isAaveGovCheck = isAaveGov(govContract)

  // get total amount
  const proposalCount = useProposalCount()
  const ids = proposalCount ? Array.from({ length: proposalCount }, (v, k) => [isAaveGovCheck ? k : k + 1]) : [['']]

  const statusRes = useSingleContractMultipleData(
    proposalCount ? govContract : undefined,
    isAaveGovCheck ? 'getProposalState' : 'state',
    ids,
    NEVER_RELOAD
  )

  useEffect(() => {
    if (!statuses) {
      const formattedRes = statusRes?.map(res => {
        if (!res.loading && res.valid) {
          return res.result?.[0]
        }
      })
      if (formattedRes[0]) {
        setStatuses(formattedRes)
      }
    }
  }, [statuses, statusRes])

  return statuses
}

export function useProposalStatus(id: string): string | undefined {
  const allStatuses = useAllProposalStates()
  return allStatuses ? enumerateProposalState(allStatuses[parseInt(id) - 1]) : undefined
}

export function useAllProposals(): { [id: string]: ProposalData } | undefined {
  const [proposals, setProposals] = useState<{ [id: string]: ProposalData } | undefined>()

  // get subgraph client for active protocol
  const govClient = useSubgraphClient()

  const govToken = useGovernanceToken()

  // reset proposals on protocol change
  const [activeProtocol] = useActiveProtocol()
  useEffect(() => {
    setProposals(undefined)
  }, [activeProtocol])

  // get number of proposals
  const amount = useProposalCount()

  // need to manually fetch counts and states as not in subgraph
  const govContract = useGovernanceContract()
  const ids = amount ? Array.from({ length: amount }, (v, k) => [k + 1]) : [['']]
  const counts = useSingleContractMultipleData(
    amount ? govContract : undefined,
    isAaveGov(govContract) ? 'getProposalById' : 'proposals',
    ids
  )
  const states = useAllProposalStates()

  // subgraphs only store ids in lowercase, format
  useEffect(() => {
    async function fetchData() {
      try {
        if (govToken) {
          fetchProposals(govClient, govToken.address).then((data: ProposalData[] | null) => {
            if (data) {
              const proposalMap = data.reduce<{ [id: string]: ProposalData }>((accum, proposal: ProposalData) => {
                accum[proposal.id] = proposal
                return accum
              }, {})
              setProposals(proposalMap)
            }
          })
        }
      } catch (e) {
        console.log(e)
      }
    }
    if (!proposals && govToken) {
      fetchData()
    }
  }, [govClient, govToken, proposals, states])

  useEffect(() => {
    if (counts && proposals && govToken) {
      Object.values(proposals).map((p, i) => {
        p.forCount = counts?.[i]?.result?.forVotes
          ? parseFloat(new TokenAmount(govToken, counts?.[i]?.result?.forVotes).toExact())
          : undefined
        p.againstCount = counts?.[i]?.result?.againstVotes
          ? parseFloat(new TokenAmount(govToken, counts?.[i]?.result?.againstVotes).toExact())
          : undefined
        return true
      })
    }
  }, [counts, govToken, proposals])

  return proposals
}

export function useProposalData(id: string): ProposalData | undefined {
  const allProposalData = useAllProposals()
  return allProposalData?.[id]
}

// get the users delegatee if it exists
export function useUserDelegatee(): string {
  const { account } = useActiveWeb3React()  
  const tokenContract = useGovTokenContract()
  const { result } = useSingleCallResult(
    tokenContract,
    isAaveTokenContract(tokenContract) ? 'getDelegateeByType' : 'delegates',
    isAaveTokenContract(tokenContract) ? [account ?? undefined, 0] : [account ?? undefined]
  )
  return result?.[0] ?? undefined
}

// gets the users current votes
export function useUserVotes(): TokenAmount | undefined {
  const { account } = useActiveWeb3React()
  const govTokenContract = useGovTokenContract()

  const govToken = useGovernanceToken()

  // check for available votes
  const votes = useSingleCallResult(
    govTokenContract,
    isAaveTokenContract(govTokenContract) ? 'getPowerCurrent' : 'getCurrentVotes',
    isAaveTokenContract(govTokenContract) ? [account ?? undefined, 0] : [account ?? undefined]
  )?.result?.[0]
  return votes && govToken ? new TokenAmount(govToken, votes) : undefined
}

// fetch available votes as of block (usually proposal start block)
export function useUserVotesAsOfBlock(block: number | undefined): TokenAmount | undefined {
  const { account } = useActiveWeb3React()
  const govTokenContract = useGovTokenContract()

  const govToken = useGovernanceToken()

  // check for available votes
  const votes = useSingleCallResult(
    govTokenContract,
    isAaveTokenContract(govTokenContract) ? 'getPowerAtBlock' : 'getPriorVotes',
    isAaveTokenContract(govTokenContract)
      ? [account ?? undefined, block ?? undefined, 0]
      : [account ?? undefined, block ?? undefined]
  )?.result?.[0]
  return votes && govToken ? new TokenAmount(govToken, votes) : undefined
}

export function useDelegateCallback(): (delegatee: string | undefined) => undefined | Promise<string> {
  const { account, chainId, library } = useActiveWeb3React()
  const addTransaction = useTransactionAdder()

  const govTokenContract = useGovTokenContract()

  return useCallback(
    (delegatee: string | undefined) => {
      if (!library || !chainId || !account || !isAddress(delegatee ?? '')) return undefined
      const args = [delegatee]
      if (!govTokenContract) throw new Error('No Governance Contract!')
      return govTokenContract.estimateGas.delegate(...args, {}).then(estimatedGasLimit => {
        return govTokenContract
          .delegate(...args, { value: null, gasLimit: calculateGasMargin(estimatedGasLimit) })
          .then((response: TransactionResponse) => {
            addTransaction(response, {
              summary: `Delegated votes`
            })
            return response.hash
          })
      })
    },
    [account, addTransaction, chainId, library, govTokenContract]
  )
}

export function useVoteCallback(): {
  voteCallback: (proposalId: string | undefined, support: boolean) => undefined | Promise<string>
} {
  const { account } = useActiveWeb3React()

  const govContract = useGovernanceContract()
  const addTransaction = useTransactionAdder()
  const isAaveGovCheck = isAaveGov(govContract)

  const voteCallback = useCallback(
    (proposalId: string | undefined, support: boolean) => {
      if (!account || !govContract || !proposalId) return
      const args = [proposalId, support]
      if (isAaveGovCheck) {
        return govContract.estimateGas.submitVote(...args, {}).then(estimatedGasLimit => {
          return govContract
            .submitVote(...args, { value: null, gasLimit: calculateGasMargin(estimatedGasLimit) })
            .then((response: TransactionResponse) => {
              addTransaction(response, {
                summary: `Voted ${support ? 'for ' : 'against'} proposal ${proposalId}`
              })
              return response.hash
            })
        })
      } else {
        return govContract.estimateGas.castVote(...args, {}).then(estimatedGasLimit => {
          return govContract
            .castVote(...args, { value: null, gasLimit: calculateGasMargin(estimatedGasLimit) })
            .then((response: TransactionResponse) => {
              addTransaction(response, {
                summary: `Voted ${support ? 'for ' : 'against'} proposal ${proposalId}`
              })
              return response.hash
            })
        })
      }
    },
    [account, addTransaction, govContract, isAaveGovCheck]
  )
  return { voteCallback }
}

export function useAllVotersForProposal(
  proposalID: string,
  support: boolean
):
  | {
      votes: string
      voter: {
        id: string
      }
    }[]
  | undefined {
  const subgraphClient = useSubgraphClient()

  const [voters, setVoters] = useState<
    | {
        votes: string
        voter: {
          id: string
        }
      }[]
    | undefined
  >()

  useEffect(() => {
    setVoters(undefined)
  }, [proposalID, subgraphClient])

  useEffect(() => {
    async function fetchData() {
      subgraphClient
        ?.query({
          query: ALL_VOTERS,
          variables: {
            proposalID,
            support
          }
        })
        .then(
          (res: {
            data: {
              votes: {
                votes: string
                voter: {
                  id: string
                }
              }[]
            }
          }) => {
            setVoters(res.data.votes)
          }
        )
    }
    if (!voters) {
      fetchData()
    }
  })

  return voters
}

export interface DelegateInfo {
  // amount of votes delegated to them
  delegatedVotes: number

  // amount of delegates they represent
  tokenHoldersRepresentedAmount: number

  // proposals theyve voted on
  votes: {
    proposal: number
    votes: number
    support: boolean
  }[]

  EOA: boolean | null // null means loading
  autonomous?: boolean
}

interface DelegateInfoRes {
  data:
    | {
        delegates: {
          id: string
          delegatedVotes: string
          tokenHoldersRepresentedAmount: number
          votes: {
            proposal: {
              id: string
            }
            support: boolean
            votes: string
          }[]
        }[]
      }
    | undefined
}

// undefined means loading, null means no delegate found
export function useDelegateInfo(address: string | undefined): DelegateInfo | undefined | null {
  const { library } = useActiveWeb3React()
  const client = useSubgraphClient()

  const [data, setData] = useState<DelegateInfo | undefined | null>()

  const isEOA = useIsEOA(address)

  useEffect(() => {
    async function fetchData() {
      client
        ?.query({
          query: DELEGATE_INFO,
          variables: {
            address: address?.toLocaleLowerCase()
          }
        })
        .then(async (res: DelegateInfoRes) => {
          if (res && res.data && res.data?.delegates[0]) {
            const source = await library?.getCode(res.data.delegates[0].id)
            const resData = res.data.delegates[0]

            if (!resData) {
              setData({
                delegatedVotes: 0,
                tokenHoldersRepresentedAmount: 0,
                votes: [],
                EOA: isEOA,
                autonomous: source === AUTONOMOUS_PROPOSAL_BYTECODE
              })
            }

            const votes = resData
              ? resData.votes
                  // sort in order created
                  .sort((a, b) => (parseInt(a.proposal.id) > parseInt(b.proposal.id) ? 1 : -1))
                  .map((v: { proposal: { id: string }; support: boolean; votes: string }) => ({
                    proposal: parseInt(v.proposal.id),
                    votes: parseFloat(v.votes),
                    support: v.support
                  }))
              : []
            setData({
              delegatedVotes: parseFloat(resData?.delegatedVotes ?? '0'),
              tokenHoldersRepresentedAmount: resData?.tokenHoldersRepresentedAmount ?? 0,
              votes,
              EOA: isEOA,
              autonomous: source === AUTONOMOUS_PROPOSAL_BYTECODE
            })
          } else {
            setData(null)
          }
        })
        .catch(e => {
          console.log(e)
        })
    }
    if (!data && address && library) {
      fetchData()
    }
  }, [address, client, data, isEOA, library])

  return data
}
